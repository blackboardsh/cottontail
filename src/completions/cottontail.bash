#!/usr/bin/env bash

_cottontail_completions() {
    local current previous command
    current="${COMP_WORDS[COMP_CWORD]}"
    previous="${COMP_WORDS[COMP_CWORD - 1]}"
    command="${COMP_WORDS[1]}"

    case "${previous}" in
        -c|--config|--cwd|--env-file|--preload|-r|--tsconfig-override)
            COMPREPLY=( $(compgen -f -- "${current}") )
            return
            ;;
        --loader)
            COMPREPLY=( $(compgen -W "js jsx ts tsx json text file wasm napi" -- "${current}") )
            return
            ;;
        --target)
            COMPREPLY=( $(compgen -W "browser node bun" -- "${current}") )
            return
            ;;
    esac

    if [[ ${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "run test build repl exec completions getcompletes --help --version --revision" -- "${current}") )
        COMPREPLY+=( $(compgen -f -- "${current}") )
        return
    fi

    case "${command}" in
        run|exec)
            COMPREPLY=( $(compgen -W "--help --cwd --env-file --preload --smol --watch --hot" -- "${current}") )
            COMPREPLY+=( $(compgen -f -- "${current}") )
            ;;
        test)
            COMPREPLY=( $(compgen -W "--help --timeout --max-concurrency --rerun-each --retry --bail --only --todo --concurrent --randomize --seed --coverage --update-snapshots" -- "${current}") )
            COMPREPLY+=( $(compgen -f -- "${current}") )
            ;;
        build)
            COMPREPLY=( $(compgen -W "--help --outdir --outfile --target --format --minify --sourcemap --external --define --loader --watch" -- "${current}") )
            COMPREPLY+=( $(compgen -f -- "${current}") )
            ;;
        repl)
            COMPREPLY=( $(compgen -W "--help --eval --print --preload --smol --config --cwd --env-file --no-env-file" -- "${current}") )
            ;;
    esac
}

complete -F _cottontail_completions cottontail
