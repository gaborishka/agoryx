#compdef agoryx
_agoryx() {
  local -a commands
  commands=(
    'chat:Start chat'
    'sessions:Session management'
    'config:Configuration diagnostics'
    'completion:Shell completion'
    'man:Manual page'
    'help:Help'
  )

  _arguments -C \
    '(-h --help)'{-h,--help}'[Show help]' \
    '(-V --version)'{-V,--version}'[Show version]' \
    '1:command:->command' \
    '*::args:->args'

  case $state in
    command)
      _describe -t commands 'agoryx command' commands
      ;;
    args)
      case $words[2] in
        sessions)
          _values 'sessions subcommand' list export
          ;;
        completion)
          _values 'shell' bash zsh fish
          ;;
      esac
      ;;
  esac
}
_agoryx "$@"
