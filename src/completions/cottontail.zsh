#compdef cottontail

_cottontail() {
    local -a commands
    commands=(
        'run:Run a JavaScript or TypeScript entrypoint'
        'test:Run tests'
        'build:Bundle entrypoints'
        'repl:Start the JavaScript REPL'
        'exec:Run an entrypoint in exec mode'
        'completions:Install or print shell completions'
        'getcompletes:Print completion candidates'
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        _files
        return
    fi

    case "${words[2]}" in
        run|exec)
            _arguments \
                '(-h --help)'{-h,--help}'[Show help]' \
                '--cwd[Set the working directory]:directory:_directories' \
                '--env-file[Load an environment file]:file:_files' \
                '(-r --preload)'{-r,--preload}'[Preload a module]:module:_files' \
                '--smol[Reduce memory usage]' \
                '--watch[Restart on changes]' \
                '*:entrypoint:_files'
            ;;
        test)
            _arguments \
                '(-h --help)'{-h,--help}'[Show help]' \
                '--timeout[Set the per-test timeout]:milliseconds' \
                '--max-concurrency[Set parallel test count]:count' \
                '--retry[Retry failed tests]:count' \
                '--coverage[Generate coverage]' \
                '(-u --update-snapshots)'{-u,--update-snapshots}'[Update snapshots]' \
                '*:test file:_files'
            ;;
        build)
            _arguments \
                '(-h --help)'{-h,--help}'[Show help]' \
                '--outdir[Write output to a directory]:directory:_directories' \
                '--outfile[Write output to a file]:file:_files' \
                '--target[Set the build target]:target:(browser node bun)' \
                '--format[Set output format]:format:(esm cjs iife)' \
                '--minify[Minify output]' \
                '--sourcemap[Generate source maps]' \
                '*:entrypoint:_files'
            ;;
        repl)
            _arguments \
                '(-h --help)'{-h,--help}'[Show help]' \
                '(-e --eval)'{-e,--eval}'[Evaluate a script]:script' \
                '(-p --print)'{-p,--print}'[Evaluate and print a script]:script' \
                '(-r --preload)'{-r,--preload}'[Preload a module]:module:_files' \
                '--smol[Reduce memory usage]'
            ;;
    esac
}

_cottontail "$@"
