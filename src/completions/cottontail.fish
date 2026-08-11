complete -e -c cottontail

set -l cottontail_commands run test build repl exec completions getcompletes

complete -c cottontail -n "__fish_use_subcommand" -a run -d "Run a JavaScript or TypeScript entrypoint"
complete -c cottontail -n "__fish_use_subcommand" -a test -d "Run tests"
complete -c cottontail -n "__fish_use_subcommand" -a build -d "Bundle entrypoints"
complete -c cottontail -n "__fish_use_subcommand" -a repl -d "Start the JavaScript REPL"
complete -c cottontail -n "__fish_use_subcommand" -a exec -d "Run an entrypoint in exec mode"
complete -c cottontail -n "__fish_use_subcommand" -a completions -d "Install or print shell completions"
complete -c cottontail -n "__fish_use_subcommand" -a getcompletes -d "Print completion candidates"

complete -c cottontail -s h -l help -d "Show help"
complete -c cottontail -s v -l version -d "Show version"
complete -c cottontail -l revision -d "Show version and revision"

complete -c cottontail -n "__fish_seen_subcommand_from run exec" -l cwd -r -F -d "Set the working directory"
complete -c cottontail -n "__fish_seen_subcommand_from run exec" -l env-file -r -F -d "Load an environment file"
complete -c cottontail -n "__fish_seen_subcommand_from run exec" -s r -l preload -r -F -d "Preload a module"
complete -c cottontail -n "__fish_seen_subcommand_from run exec" -l smol -d "Reduce memory usage"
complete -c cottontail -n "__fish_seen_subcommand_from run exec" -l watch -d "Restart on changes"

complete -c cottontail -n "__fish_seen_subcommand_from test" -l timeout -r -d "Set the per-test timeout"
complete -c cottontail -n "__fish_seen_subcommand_from test" -l max-concurrency -r -d "Set parallel test count"
complete -c cottontail -n "__fish_seen_subcommand_from test" -l retry -r -d "Retry failed tests"
complete -c cottontail -n "__fish_seen_subcommand_from test" -l coverage -d "Generate coverage"
complete -c cottontail -n "__fish_seen_subcommand_from test" -s u -l update-snapshots -d "Update snapshots"

complete -c cottontail -n "__fish_seen_subcommand_from build" -l outdir -r -F -d "Write output to a directory"
complete -c cottontail -n "__fish_seen_subcommand_from build" -l outfile -r -F -d "Write output to a file"
complete -c cottontail -n "__fish_seen_subcommand_from build" -l target -r -a "browser node bun" -d "Set the build target"
complete -c cottontail -n "__fish_seen_subcommand_from build" -l minify -d "Minify output"

complete -c cottontail -n "__fish_seen_subcommand_from run test build exec" -F
