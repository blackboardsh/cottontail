/// allocated using bun.default_allocator. when called from lldb, it is never freed.
pub export fn dumpBtjsTrace() [*:0]const u8 {
    if (comptime bun.Environment.isDebug) {
        return dumpBtjsTraceDebugImpl();
    }

    return "btjs is disabled in release builds";
}

fn dumpBtjsTraceDebugImpl() [*:0]const u8 {
    var result_writer = std.Io.Writer.Allocating.init(bun.default_allocator);
    defer result_writer.deinit();
    const w = &result_writer.writer;

    const debug_info = std.debug.getSelfDebugInfo() catch |err| {
        w.print("Unable to dump stack trace: Unable to open debug info: {s}\x00", .{@errorName(err)}) catch {
            return "<oom>".ptr;
        };
        return @ptrCast((result_writer.toOwnedSlice() catch {
            return "<oom>".ptr;
        }).ptr);
    };

    // std.log.info("jsc_llint_begin: {x}", .{@intFromPtr(&jsc_llint_begin)});
    // std.log.info("jsc_llint_end: {x}", .{@intFromPtr(&jsc_llint_end)});

    const tty_config = std.io.tty.detectConfig(std.fs.File.stdout());

    var context: std.debug.ThreadContext = undefined;
    const has_context = std.debug.getContext(&context);

    var it: std.debug.StackIterator = (if (has_context and !bun.Environment.isWindows) blk: {
        break :blk std.debug.StackIterator.initWithContext(null, debug_info, &context) catch null;
    } else null) orelse std.debug.StackIterator.init(null, null);
    defer it.deinit();

    while (it.next()) |return_address| {
        printLastUnwindError(&it, debug_info, w, tty_config);

        // On arm64 macOS, the address of the last frame is 0x0 rather than 0x1 as on x86_64 macOS,
        // therefore, we do a check for `return_address == 0` before subtracting 1 from it to avoid
        // an overflow. We do not need to signal `StackIterator` as it will correctly detect this
        // condition on the subsequent iteration and return `null` thus terminating the loop.
        // same behaviour for x86-windows-msvc
        const address = return_address -| 1;
        printSourceAtAddress(debug_info, w, address, tty_config, it.fp) catch {};
    } else {
        printLastUnwindError(&it, debug_info, w, tty_config);
    }

    // remove nulls
    for (result_writer.written()) |*itm| if (itm.* == 0) {
        itm.* = ' ';
    };
    // add null terminator
    w.writeByte(0) catch {
        return "<oom>".ptr;
    };
    return @ptrCast((result_writer.toOwnedSlice() catch {
        return "<oom>".ptr;
    }).ptr);
}


const bun = @import("bun");
const std = @import("std");
