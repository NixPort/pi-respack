#!/bin/bash
# 端到端：真的 pi 打开一个会话时，伴生扩展把没有收尾记录的运行次补成「已中断」。
#
# 不需要模型：pi 以 RPC 模式启动，打开那个会话（session_start 照常发生），然后我们关掉它的
# stdin，它自己退出。做完看会话文件里有没有那条记录。
set -u

ROOT=$(mktemp -d)
SESSION_ID="11111111-2222-3333-4444-555555555555"
WORK="$ROOT/work"
SESSIONS="$ROOT/sessions"
mkdir -p "$WORK" "$SESSIONS"

# 一个空会话：引擎自己的会话文件长这样，头一行是它自己。
cat > "$SESSIONS/$SESSION_ID.jsonl" <<EOF
{"type":"session","version":3,"id":"$SESSION_ID","timestamp":"2026-11-24T06:00:00.000Z","cwd":"$WORK"}
EOF

# 一段没有收尾记录的 transcript：它是一次跑到一半被掐断的运行。
ENCODED=$(echo "$WORK" | sed 's#/#-#g')
TASKS="$ROOT/pi-subagents-$(id -u)/$ENCODED/$SESSION_ID/tasks"
mkdir -p "$TASKS"
cat > "$TASKS/agent-1.output" <<'EOF'
{"isSidechain":true,"agentId":"agent-1","type":"user","message":{"role":"user","content":"do the thing"},"timestamp":"2026-11-24T06:00:00.000Z","cwd":"/tmp/work"}
{"isSidechain":true,"agentId":"agent-1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]},"timestamp":"2026-11-24T06:00:30.000Z","cwd":"/tmp/work"}
EOF

echo ">> the transcript: $TASKS/agent-1.output"

# pi 打开那个会话：session_start 发生，伴生扩展认领那次运行。
cd "$(dirname "$0")/.." || exit 1
TMPDIR="$ROOT" ~/.local/bin/pi --mode rpc --session "$SESSIONS/$SESSION_ID.jsonl" \
    -e ./local-extensions/nx2a-subagent-records < /dev/null > "$ROOT/rpc.out" 2> "$HOME/.pi/agent/rpc.err"
echo ">> pi said: $(head -c 200 "$ROOT/rpc.out")"

echo ">> the session file now says:"
grep -o '"customType":"subagents:record"[^}]*}[^}]*}' "$SESSIONS/$SESSION_ID.jsonl" || echo "   (no record — the adoption did not happen)"
echo ">> the whole file:"
cat "$SESSIONS/$SESSION_ID.jsonl"
rm -rf "$ROOT"
