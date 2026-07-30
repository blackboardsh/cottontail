const websocket_frame = @import("../../websocket_frame.zig");

pub fn forceLink() void {
    _ = &websocket_frame.ct_websocket_frame_encode;
    _ = &websocket_frame.ct_websocket_unmask_copy;
}
