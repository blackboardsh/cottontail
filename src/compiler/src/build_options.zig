const std = @import("std");

pub const override_no_export_cpp_apis = true;
pub const zig_self_hosted_backend = false;
pub const reported_nodejs_version = "24.0.0";
pub const baseline = false;
pub const sha = "";
pub const is_canary = false;
pub const canary_revision = "";
pub const base_path = "";
pub const enable_logs = false;
pub const enable_asan = false;
pub const enable_fuzzilli = false;
pub const enable_tinycc = false;
pub const codegen_path = "";
pub const codegen_embed = false;
pub const version = std.SemanticVersion{ .major = 1, .minor = 3, .patch = 14 };
pub const fallback_html_version = 0;
pub const use_mimalloc = false;
