const std = @import("std");
const compiler = @import("cottontail_compiler");

const Semver = compiler.Semver;
const Value = std.json.Value;

const seven_days_ms: f64 = 7 * std.time.ms_per_day;

pub const Result = struct {
    version: []const u8,
    newest_filtered: ?[]const u8 = null,
};

const Candidate = struct {
    name: []const u8,
    version: Semver.Version,
};

pub fn selectVersion(
    allocator: std.mem.Allocator,
    manifest: *const Value,
    package_name: []const u8,
    spec: []const u8,
    minimum_release_age_ms: ?f64,
    exclusions: []const []const u8,
    now_ms: f64,
) !Result {
    if (manifest.* != .object) return error.InvalidRegistryManifest;
    const versions_value = manifest.object.get("versions") orelse return error.NoMatchingVersion;
    if (versions_value != .object) return error.InvalidRegistryManifest;

    const age_gate = if (minimum_release_age_ms) |minimum_age|
        if (minimum_age > 0 and !isExcluded(package_name, exclusions)) minimum_age else null
    else
        null;
    if (age_gate == null) {
        return .{ .version = try selectUnfiltered(allocator, manifest, &versions_value.object, spec) };
    }

    var releases = std.array_list.Managed(Candidate).init(allocator);
    defer releases.deinit();
    var prereleases = std.array_list.Managed(Candidate).init(allocator);
    defer prereleases.deinit();
    try collectCandidates(&versions_value.object, &releases, &prereleases);

    if (findCandidate(releases.items, spec) orelse findCandidate(prereleases.items, spec)) |exact| {
        if (isTooRecent(manifest, exact.name, age_gate.?, now_ms)) return error.TooRecentVersion;
        return .{ .version = exact.name };
    }

    if (distTagVersion(manifest, spec)) |tagged_version| {
        const tagged = findCandidate(releases.items, tagged_version) orelse
            findCandidate(prereleases.items, tagged_version) orelse
            return error.NoMatchingVersion;
        return selectDistTag(manifest, tagged, releases.items, prereleases.items, age_gate.?, now_ms);
    }

    const effective_spec = if (spec.len == 0) "*" else spec;
    if (Semver.Version.isTaggedVersionOnly(effective_spec)) return error.NoMatchingVersion;

    const sliced = Semver.SlicedString.init(effective_spec, effective_spec);
    var query = Semver.Query.parse(allocator, effective_spec, sliced) catch return error.NoMatchingVersion;
    defer query.deinit();

    const left = query.head.head.range.left;
    if (left.op == .eql) {
        const exact = findParsedCandidate(releases.items, left.version, effective_spec) orelse
            findParsedCandidate(prereleases.items, left.version, effective_spec) orelse
            return error.NoMatchingVersion;
        if (isTooRecent(manifest, exact.name, age_gate.?, now_ms)) return error.TooRecentVersion;
        return .{ .version = exact.name };
    }

    var newest_filtered: ?[]const u8 = null;
    if (distTagVersion(manifest, "latest")) |latest_name| {
        if (findCandidate(releases.items, latest_name) orelse findCandidate(prereleases.items, latest_name)) |latest| {
            if (query.satisfies(latest.version, effective_spec, latest.name)) {
                if (isTooRecent(manifest, latest.name, age_gate.?, now_ms)) {
                    newest_filtered = latest.name;
                } else if (query.flags.isSet(Semver.Query.Group.Flags.pre)) {
                    if (left.version.order(latest.version, effective_spec, latest.name) == .eq) {
                        return .{ .version = latest.name };
                    }
                } else {
                    return .{ .version = latest.name };
                }
            }
        }
    }

    if (searchVersionList(
        manifest,
        releases.items,
        &query,
        effective_spec,
        age_gate.?,
        now_ms,
        &newest_filtered,
    )) |result| return result;

    if (query.flags.isSet(Semver.Query.Group.Flags.pre)) {
        if (searchVersionList(
            manifest,
            prereleases.items,
            &query,
            effective_spec,
            age_gate.?,
            now_ms,
            &newest_filtered,
        )) |result| return result;
    }

    if (newest_filtered != null) return error.AllVersionsTooRecent;
    return error.NoMatchingVersion;
}

fn selectUnfiltered(
    allocator: std.mem.Allocator,
    manifest: *const Value,
    versions: *const std.json.ObjectMap,
    spec: []const u8,
) ![]const u8 {
    if (versions.get(spec) != null) return spec;
    if (distTagVersion(manifest, spec)) |version| return version;

    const effective_spec = if (spec.len == 0) "*" else spec;
    if (distTagVersion(manifest, "latest")) |latest| {
        if (std.mem.eql(u8, effective_spec, "*") or semverSatisfies(allocator, effective_spec, latest)) {
            return latest;
        }
    }
    if (Semver.Version.isTaggedVersionOnly(effective_spec)) return error.NoMatchingVersion;
    return bestMatchingVersion(allocator, versions, effective_spec) orelse error.NoMatchingVersion;
}

fn selectDistTag(
    manifest: *const Value,
    tagged: Candidate,
    releases: []const Candidate,
    prereleases: []const Candidate,
    minimum_age_ms: f64,
    now_ms: f64,
) !Result {
    if (!isTooRecent(manifest, tagged.name, minimum_age_ms, now_ms)) {
        return .{ .version = tagged.name };
    }

    const candidates = if (tagged.version.tag.hasPre()) prereleases else releases;
    const expected_tag = if (tagged.version.tag.hasPre()) prereleaseBase(tagged) else null;
    const stability_window_ms = @min(minimum_age_ms, seven_days_ms);
    var best: ?Candidate = null;
    var previous_blocked = tagged;

    for (candidates) |candidate| {
        if (candidate.version.order(tagged.version, candidate.name, tagged.name) == .gt) continue;
        if (expected_tag) |expected| {
            if (!std.mem.eql(u8, prereleaseBase(candidate), expected)) continue;
        }

        if (isTooRecent(manifest, candidate.name, minimum_age_ms, now_ms)) {
            previous_blocked = candidate;
            continue;
        }

        const timestamp = publishTimestamp(manifest, candidate.name);
        if (timestamp < now_ms - (minimum_age_ms + seven_days_ms)) {
            return .{
                .version = (best orelse candidate).name,
                .newest_filtered = tagged.name,
            };
        }

        const previous_timestamp = publishTimestamp(manifest, previous_blocked.name);
        if (previous_timestamp - timestamp >= stability_window_ms) {
            return .{ .version = candidate.name, .newest_filtered = tagged.name };
        }
        if (best == null) best = candidate;
        previous_blocked = candidate;
    }

    if (best) |candidate| {
        return .{ .version = candidate.name, .newest_filtered = tagged.name };
    }
    return error.AllVersionsTooRecent;
}

fn searchVersionList(
    manifest: *const Value,
    candidates: []const Candidate,
    query: *const Semver.Query.Group,
    query_text: []const u8,
    minimum_age_ms: f64,
    now_ms: f64,
    newest_filtered: *?[]const u8,
) ?Result {
    const stability_window_ms = @min(minimum_age_ms, seven_days_ms);
    var previous_blocked: ?Candidate = null;
    var best: ?Candidate = null;

    for (candidates) |candidate| {
        if (!query.satisfies(candidate.version, query_text, candidate.name)) continue;
        if (isTooRecent(manifest, candidate.name, minimum_age_ms, now_ms)) {
            if (newest_filtered.* == null) newest_filtered.* = candidate.name;
            previous_blocked = candidate;
            continue;
        }

        if (previous_blocked) |previous| {
            const timestamp = publishTimestamp(manifest, candidate.name);
            if (timestamp < now_ms - (minimum_age_ms + seven_days_ms)) {
                if (best == null) best = candidate;
                break;
            }

            const previous_timestamp = publishTimestamp(manifest, previous.name);
            if (previous_timestamp - timestamp >= stability_window_ms) {
                best = candidate;
                break;
            }
            if (best == null) best = candidate;
            previous_blocked = candidate;
            continue;
        }

        return .{ .version = candidate.name };
    }

    if (best) |candidate| {
        return .{ .version = candidate.name, .newest_filtered = newest_filtered.* };
    }
    return null;
}

fn collectCandidates(
    versions: *const std.json.ObjectMap,
    releases: *std.array_list.Managed(Candidate),
    prereleases: *std.array_list.Managed(Candidate),
) !void {
    for (versions.keys()) |version_name| {
        const parsed = Semver.Version.parseUTF8(version_name);
        if (!parsed.valid) continue;
        const candidate: Candidate = .{ .name = version_name, .version = parsed.version.min() };
        if (candidate.version.tag.hasPre()) {
            try prereleases.append(candidate);
        } else {
            try releases.append(candidate);
        }
    }
    std.mem.sort(Candidate, releases.items, {}, candidateGreaterThan);
    std.mem.sort(Candidate, prereleases.items, {}, candidateGreaterThan);
}

fn candidateGreaterThan(_: void, lhs: Candidate, rhs: Candidate) bool {
    return lhs.version.order(rhs.version, lhs.name, rhs.name) == .gt;
}

fn findCandidate(candidates: []const Candidate, name: []const u8) ?Candidate {
    for (candidates) |candidate| {
        if (std.mem.eql(u8, candidate.name, name)) return candidate;
    }
    return null;
}

fn findParsedCandidate(candidates: []const Candidate, version: Semver.Version, version_buf: []const u8) ?Candidate {
    for (candidates) |candidate| {
        if (version.order(candidate.version, version_buf, candidate.name) == .eq) return candidate;
    }
    return null;
}

fn distTagVersion(manifest: *const Value, tag: []const u8) ?[]const u8 {
    if (manifest.* != .object) return null;
    const dist_tags = manifest.object.get("dist-tags") orelse return null;
    if (dist_tags != .object) return null;
    const value = dist_tags.object.get(tag) orelse return null;
    return if (value == .string) value.string else null;
}

fn prereleaseBase(candidate: Candidate) []const u8 {
    const prerelease = candidate.version.tag.pre.slice(candidate.name);
    const dot = std.mem.indexOfScalar(u8, prerelease, '.') orelse return prerelease;
    return prerelease[0..dot];
}

fn isExcluded(package_name: []const u8, exclusions: []const []const u8) bool {
    for (exclusions) |excluded| {
        if (std.mem.eql(u8, package_name, excluded)) return true;
    }
    return false;
}

fn isTooRecent(manifest: *const Value, version_name: []const u8, minimum_age_ms: f64, now_ms: f64) bool {
    return publishTimestamp(manifest, version_name) > now_ms - minimum_age_ms;
}

fn publishTimestamp(manifest: *const Value, version_name: []const u8) f64 {
    if (manifest.* != .object) return 0;
    const time = manifest.object.get("time") orelse return 0;
    if (time != .object) return 0;
    const value = time.object.get(version_name) orelse return 0;
    if (value != .string) return 0;
    const timestamp = compiler.jsc.wtf.parseES5Date(value.string) catch return 0;
    return if (std.math.isFinite(timestamp)) timestamp else 0;
}

fn semverSatisfies(allocator: std.mem.Allocator, range: []const u8, version_value: []const u8) bool {
    if (std.mem.eql(u8, range, "") or std.mem.eql(u8, range, "*") or std.mem.eql(u8, range, "latest")) return true;
    const parsed_version = Semver.Version.parseUTF8(version_value);
    if (!parsed_version.valid) return false;
    const sliced = Semver.SlicedString.init(range, range);
    var query = Semver.Query.parse(allocator, range, sliced) catch return false;
    defer query.deinit();
    return query.satisfies(parsed_version.version.min(), range, version_value);
}

fn bestMatchingVersion(
    allocator: std.mem.Allocator,
    versions: *const std.json.ObjectMap,
    range: []const u8,
) ?[]const u8 {
    var best: ?[]const u8 = null;
    var best_parsed: ?Semver.Version = null;
    for (versions.keys()) |version_value| {
        if (!semverSatisfies(allocator, range, version_value)) continue;
        const parsed = Semver.Version.parseUTF8(version_value);
        if (!parsed.valid) continue;
        const concrete = parsed.version.min();
        if (best_parsed == null or concrete.order(best_parsed.?, version_value, best.?) == .gt) {
            best = version_value;
            best_parsed = concrete;
        }
    }
    return best;
}

test "minimum release age uses Bun stability window" {
    const source =
        \\{
        \\  "dist-tags": { "latest": "1.0.3" },
        \\  "versions": { "1.0.0": {}, "1.0.1": {}, "1.0.2": {}, "1.0.3": {} },
        \\  "time": {
        \\    "1.0.0": "2026-01-02T00:00:00.000Z",
        \\    "1.0.1": "2026-01-07T12:00:00.000Z",
        \\    "1.0.2": "2026-01-08T12:00:00.000Z",
        \\    "1.0.3": "2026-01-09T12:00:00.000Z"
        \\  }
        \\}
    ;
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, source, .{});
    defer parsed.deinit();
    const now_ms = try compiler.jsc.wtf.parseES5Date("2026-01-10T00:00:00.000Z");
    const result = try selectVersion(
        std.testing.allocator,
        &parsed.value,
        "example",
        "latest",
        1.8 * std.time.ms_per_day,
        &.{},
        now_ms,
    );
    try std.testing.expectEqualStrings("1.0.0", result.version);
    try std.testing.expectEqualStrings("1.0.3", result.newest_filtered.?);
}

test "minimum release age rejects a recent exact version" {
    const source =
        \\{
        \\  "dist-tags": { "latest": "2.0.0" },
        \\  "versions": { "1.0.0": {}, "2.0.0": {} },
        \\  "time": { "1.0.0": "2025-12-01T00:00:00.000Z", "2.0.0": "2026-01-09T00:00:00.000Z" }
        \\}
    ;
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, source, .{});
    defer parsed.deinit();
    const now_ms = try compiler.jsc.wtf.parseES5Date("2026-01-10T00:00:00.000Z");
    try std.testing.expectError(
        error.TooRecentVersion,
        selectVersion(std.testing.allocator, &parsed.value, "example", "2.0.0", 5 * std.time.ms_per_day, &.{}, now_ms),
    );
}
