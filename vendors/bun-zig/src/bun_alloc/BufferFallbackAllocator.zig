/// An allocator that attempts to allocate from a provided buffer first,
/// falling back to another allocator when the buffer is exhausted.
/// Unlike `std.heap.StackFallbackAllocator`, this does not own the buffer.
const BufferFallbackAllocator = @This();

_fallback_allocator: Allocator,
_fixed_buffer_allocator: FixedBufferAllocator,

pub fn init(buffer: []u8, fallback_allocator: Allocator) BufferFallbackAllocator {
    return .{
        ._fallback_allocator = fallback_allocator,
        ._fixed_buffer_allocator = FixedBufferAllocator.init(buffer),
    };
}

pub fn allocator(self: *BufferFallbackAllocator) Allocator {
    return .{
        .ptr = self,
        .vtable = &.{
            .alloc = alloc,
            .resize = resize,
            .remap = remap,
            .free = free,
        },
    };
}

fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
    const self: *BufferFallbackAllocator = @ptrCast(@alignCast(ctx));
    return FixedBufferAllocator.alloc(
        &self._fixed_buffer_allocator,
        len,
        alignment,
        ra,
    ) orelse self._fallback_allocator.rawAlloc(len, alignment, ra);
}

fn resize(ctx: *anyopaque, buf: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
    const self: *BufferFallbackAllocator = @ptrCast(@alignCast(ctx));
    if (self._fixed_buffer_allocator.ownsPtr(buf.ptr)) {
        return FixedBufferAllocator.resize(
            &self._fixed_buffer_allocator,
            buf,
            alignment,
            new_len,
            ra,
        );
    }
    return self._fallback_allocator.rawResize(buf, alignment, new_len, ra);
}

fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
    const self: *BufferFallbackAllocator = @ptrCast(@alignCast(ctx));
    if (self._fixed_buffer_allocator.ownsPtr(memory.ptr)) {
        return FixedBufferAllocator.remap(
            &self._fixed_buffer_allocator,
            memory,
            alignment,
            new_len,
            ra,
        );
    }
    return self._fallback_allocator.rawRemap(memory, alignment, new_len, ra);
}

fn free(ctx: *anyopaque, buf: []u8, alignment: std.mem.Alignment, ra: usize) void {
    const self: *BufferFallbackAllocator = @ptrCast(@alignCast(ctx));
    if (self._fixed_buffer_allocator.ownsPtr(buf.ptr)) {
        return FixedBufferAllocator.free(
            &self._fixed_buffer_allocator,
            buf,
            alignment,
            ra,
        );
    }
    return self._fallback_allocator.rawFree(buf, alignment, ra);
}

pub fn reset(self: *BufferFallbackAllocator) void {
    self._fixed_buffer_allocator.reset();
}

const std = @import("std");
const Allocator = std.mem.Allocator;
const FixedBufferAllocator = std.heap.FixedBufferAllocator;
