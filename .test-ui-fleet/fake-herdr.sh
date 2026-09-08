#!/bin/sh
case "$1 $2" in
  'agent list') printf '%s\n' '{"id":"fixture","result":{"type":"agent_list","agents":[]}}' ;;
  'pane list') printf '%s\n' '{"id":"fixture","result":{"type":"pane_list","panes":[]}}' ;;
  'notification show') exit 0 ;;
  *) exit 0 ;;
esac
