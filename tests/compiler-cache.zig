test "compiler cache preserves retained value pointers across growth and updates" {
    // Refuse in-place growth: relocation must be covered on every platform,
    // regardless of the system allocator's size classes or available memory.
    var moving_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{
        .resize_fail_index = 0,
    });
    const Map = compiler.allocators.BSSMap(u64, 1, false, 8, false);
    const map = Map.init(moving_allocator.allocator());
    defer map.deinit();

    var first = try map.getOrPut("first");
    const retained = try map.put(&first, 42);
    const address = @intFromPtr(retained);
    var key_buffer: [32]u8 = undefined;
    for (0..256) |i| {
        const key = try std.fmt.bufPrint(&key_buffer, "entry-{d}", .{i});
        var entry = try map.getOrPut(key);
        _ = try map.put(&entry, i);
        // Check addresses before reading retained, so the unfixed regression
        // fails cleanly instead of dereferencing freed storage.
        try std.testing.expectEqual(address, @intFromPtr(map.get("first").?));
        try std.testing.expectEqual(address, @intFromPtr(map.atIndex(first.index).?));
        try std.testing.expectEqual(@as(u64, 42), retained.*);
    }

    var existing = try map.getOrPut("first");
    try std.testing.expectEqual(address, @intFromPtr(try map.put(&existing, 99)));
    try std.testing.expectEqual(@as(u64, 99), retained.*);
}

test "compiler cache reset releases values and allows reuse" {
    var tracking_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const Map = compiler.allocators.BSSMap(u32, 1, false, 8, false);
    const map = Map.init(tracking_allocator.allocator());
    {
        defer map.deinit();
        var entry = try map.getOrPut("old");
        _ = try map.put(&entry, 12);
        var missing = try map.getOrPut("missing");
        map.markNotFound(missing);
        const bytes_before_reset = tracking_allocator.freed_bytes;
        Map.resetInstance();
        try std.testing.expect(map.get("old") == null);
        try std.testing.expectEqual(@as(usize, 0), map.values().len);
        try std.testing.expect(tracking_allocator.freed_bytes > bytes_before_reset);

        missing = try map.getOrPut("missing");
        try std.testing.expectEqual(.unknown, missing.status);
        const value = try map.put(&missing, 34);
        try std.testing.expectEqual(@as(u32, 34), value.*);
        try std.testing.expectEqual(@as(usize, 1), map.values().len);
        try std.testing.expectEqual(@intFromPtr(value), @intFromPtr(map.atIndex(missing.index).?));
    }
    try std.testing.expectEqual(tracking_allocator.allocated_bytes, tracking_allocator.freed_bytes);
}

test "compiler cache insertion releases allocations on failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, exerciseInsertionFailures, .{});
}

fn exerciseInsertionFailures(allocator: std.mem.Allocator) !void {
    const Map = compiler.allocators.BSSMap(u16, 1, false, 8, false);
    const map = Map.init(allocator);
    defer map.deinit();
    var key_buffer: [32]u8 = undefined;
    for (0..20) |i| {
        const key = try std.fmt.bufPrint(&key_buffer, "entry-{d}", .{i});
        var entry = try map.getOrPut(key);
        const previous_index = entry.index;
        _ = map.put(&entry, @intCast(i)) catch |err| {
            try std.testing.expectEqual(previous_index, entry.index);
            try std.testing.expect(map.get(key) == null);
            return err;
        };
    }
}

const std = @import("std");
const compiler = @import("cottontail_compiler");
