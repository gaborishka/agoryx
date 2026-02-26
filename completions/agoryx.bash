# bash completion for agoryx
_agoryx_complete() {
  local cur prev words cword
  _init_completion || return

  local commands="chat sessions config completion man help"
  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands --help --version" -- "$cur") )
    return
  fi

  case "${words[1]}" in
    sessions)
      COMPREPLY=( $(compgen -W "list export --help" -- "$cur") )
      ;;
    config)
      COMPREPLY=( $(compgen -W "explain --help --config --db" -- "$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish --help" -- "$cur") )
      ;;
    chat|"")
      COMPREPLY=( $(compgen -W "--help --agents --mode --config --db --adapter-mode --quiet-system --plain-ui --no-color --resume --room-name" -- "$cur") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}
complete -F _agoryx_complete agoryx
