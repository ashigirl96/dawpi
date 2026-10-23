# usage: python3 -I summarize.py <label> <debug log> <mod log>
# Prints one JSON line per trial: how main's Agent call and the doorbell Bash were decided.
import json
import re
import sys

label, debug_path, mod_path = sys.argv[1:4]
debug = open(debug_path, errors='replace').read().splitlines()
mod = json.load(open(mod_path))


def lines(pattern):
    return [l[24:].strip()[:300] for l in debug if re.search(pattern, l)]


dispatch_ms = lambda tool: [re.search(r'permissionDecisionMs=(\d+)', l).group(1) for l in lines(rf'tool_dispatch_start tool={tool} ')]
agent_dispatch = dispatch_ms('Agent')
ev = lambda name: [e for e in mod if e['ev'] == name]
print(json.dumps({
    'label': label,
    'ignored_rules': lines(r'Ignoring dangerous permission'),
    'automode_settings': lines(r'settings autoMode in'),
    'delegate_calls': len(ev('delegate.call')),
    'delegate_dispatch_ms': dispatch_ms('mcp__cbp15__delegate'),
    'check_delegate': [e['result'] for e in ev('check.delegate')],
    'plugin_checks': lines(r'tool\.check (Agent|Bash|mcp__cbp15__delegate) \S+: '),
    'agent_dispatch_ms': agent_dispatch,
    'spawn_bound': len(ev('spawn.bound')),
    'check_agent': [e.get('decision') for e in ev('check.agent')],
    'classifier': lines(r'classifier_request_(started|finished)|\[server-classifier\]|classifier blocked|classifier unavailable|classifier gave no verdict|Skipping auto mode classifier|Hook approved tool use|Classifier denial'),
    'bell': [(e['bell'], e['result'][:160]) for e in ev('bell.call')],
    'report': [e['via'] for e in ev('report')],
    'main_turns': [e['answer'][:200] for e in ev('main.turn.complete')],
}, ensure_ascii=False, indent=1))
