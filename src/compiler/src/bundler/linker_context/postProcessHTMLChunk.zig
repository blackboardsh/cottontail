pub fn postProcessHTMLChunk(ctx: GenerateChunkCtx, worker: *ThreadPool.Worker, chunk: *Chunk) !void {
    // This is where we split output into pieces
    const c = ctx.c;
    var j = StringJoiner{
        .allocator = worker.allocator,
        .watcher = .{
            .input = chunk.unique_key,
        },
    };

    const compile_results = chunk.compile_results_for_chunk;

    for (compile_results) |compile_result| {
        // NOTE: HTML compile-result code is allocated with a worker's arena
        // (`generateCompileResultForHtmlChunk` builds `output` with
        // `worker.allocator`), so it must not be freed through
        // `bun.default_allocator` (see postProcessCSSChunk.zig).
        j.pushStatic(compile_result.code());
    }

    j.ensureNewlineAtEnd();

    chunk.intermediate_output = c.breakOutputIntoPieces(
        worker.allocator,
        &j,
        @as(u32, @truncate(ctx.chunks.len)),
    ) catch |err| bun.handleOom(err);

    chunk.isolated_hash = c.generateIsolatedHash(chunk);
}

const bun = @import("bun");
const StringJoiner = bun.StringJoiner;

const Chunk = bun.bundle_v2.Chunk;
const ThreadPool = bun.bundle_v2.ThreadPool;

const LinkerContext = bun.bundle_v2.LinkerContext;
const GenerateChunkCtx = bun.bundle_v2.LinkerContext.GenerateChunkCtx;
