pub const ZSTD_DStream = opaque {};

pub const ZSTD_inBuffer = extern struct {
    src: ?*const anyopaque,
    size: usize,
    pos: usize,
};

pub const ZSTD_outBuffer = extern struct {
    dst: ?*anyopaque,
    size: usize,
    pos: usize,
};

pub extern fn ZSTD_compress(dst: ?*anyopaque, dst_capacity: usize, src: ?*const anyopaque, src_size: usize, level: c_int) usize;
pub extern fn ZSTD_compressBound(src_size: usize) usize;
pub extern fn ZSTD_decompress(dst: ?*anyopaque, dst_capacity: usize, src: ?*const anyopaque, compressed_size: usize) usize;
pub extern fn ZSTD_defaultCLevel() c_int;
pub extern fn ZSTD_isError(code: usize) c_uint;
pub extern fn ZSTD_getErrorName(code: usize) [*:0]const u8;
pub extern fn ZSTD_createDStream() ?*ZSTD_DStream;
pub extern fn ZSTD_freeDStream(stream: *ZSTD_DStream) usize;
pub extern fn ZSTD_initDStream(stream: *ZSTD_DStream) usize;
pub extern fn ZSTD_decompressStream(stream: *ZSTD_DStream, output: *ZSTD_outBuffer, input: *ZSTD_inBuffer) usize;
