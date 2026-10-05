# fish completion for agoryx
complete -c agoryx -f -n '__fish_use_subcommand' -a "chat sessions config completion doctor service man help"
complete -c agoryx -l help -s h -d "Show help"
complete -c agoryx -l version -s V -d "Show version"
complete -c agoryx -n '__fish_seen_subcommand_from completion' -a "bash zsh fish"
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -a "list export"
complete -c agoryx -n '__fish_seen_subcommand_from doctor' -l probe -d "Also send each logged-in agent one short prompt"
complete -c agoryx -n '__fish_seen_subcommand_from doctor' -l json -d "Print the checks as JSON"
complete -c agoryx -n '__fish_seen_subcommand_from service' -a "install uninstall status"
complete -c agoryx -n '__fish_seen_subcommand_from service' -l json -d "Print the status as JSON"
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l agents -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l mode -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l db -r
complete -c agoryx -n '__fish_seen_subcommand_from chat' -l config -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l limit -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l format -r
complete -c agoryx -n '__fish_seen_subcommand_from sessions' -l out -r
