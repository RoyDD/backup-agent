#!/usr/bin/env bash
#
# 质量准入检查入口。
#
# 与 `.github/workflows/quality-gate.yml` 使用同一份脚本：CI 调它，本地也调它，
# 两边不会各自演化。检查规范见 `docs/quality/quality-gate.md`（workspace 根）。
#
# 判定语义：PASS / FAIL / SKIP / BLOCKED。SKIP 与 BLOCKED 不计为 PASS。
# 退出码：0 全部 PASS；1 存在 FAIL；3 无 FAIL 但存在 BLOCKED；2 用法或环境错误。
#
# 用法：
#   scripts/gate.sh                    # typecheck + build + test + verify:skills
#   GATE_E2E=1 scripts/gate.sh         # 追加真实模型 E2E（需要 DEEPSEEK_API_KEY 与 dsh）
#   GATE_INSTALL=1 scripts/gate.sh     # 先执行 pnpm install --frozen-lockfile
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

DSN="${BK_TEST_DSN:-postgres://postgres:verify_pw@127.0.0.1:55416/postgres}"
GATE_E2E="${GATE_E2E:-0}"
GATE_INSTALL="${GATE_INSTALL:-0}"

LOG="$(mktemp -t bkagent-gate-XXXXXX.log)"
trap 'rm -f "$LOG"' EXIT

names=()
results=()
commands=()
evidence=()

record() {
  names+=("$1")
  results+=("$2")
  commands+=("$3")
  evidence+=("$4")
}

# Runs one check, appends its outcome, and echoes the last lines on failure.
run_check() {
  local name="$1"
  local command="$2"
  shift 2
  printf '\n== %s\n$ %s\n' "$name" "$command"
  : >"$LOG"
  "$@" >>"$LOG" 2>&1
  local code=$?
  if [ "$code" -eq 0 ]; then
    record "$name" "PASS" "$command" "exit 0"
    tail -n 2 "$LOG"
    return 0
  fi
  record "$name" "FAIL" "$command" "exit $code"
  printf 'exit %s; last output:\n' "$code"
  tail -n 25 "$LOG"
  return 1
}

dsn_host() {
  printf '%s' "$1" | sed -E 's#^postgres(ql)?://([^@/]+@)?([^:/]+).*#\3#'
}

dsn_port() {
  local port
  port="$(printf '%s' "$1" | sed -nE 's#^postgres(ql)?://([^@/]+@)?[^:/]+:([0-9]+)(/.*)?$#\3#p')"
  printf '%s' "${port:-5432}"
}

postgres_ready() {
  local host port
  host="$(dsn_host "$DSN")"
  port="$(dsn_port "$DSN")"
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$host" -p "$port" -q >/dev/null 2>&1
    return $?
  fi
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
}

fail_count=0
blocked_count=0

if [ "$GATE_INSTALL" = "1" ]; then
  run_check "依赖安装" "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile || fail_count=$((fail_count + 1))
fi

run_check "静态类型检查" "pnpm -r --parallel typecheck" pnpm -r --parallel typecheck \
  || fail_count=$((fail_count + 1))

# 回放门禁执行 `dist/bkagent.mjs`：未构建时它会 SKIP，而 SKIP 不计为 PASS，
# 所以构建放在测试之前，并在构建失败时直接停止。
if ! run_check "CLI 构建" "pnpm build:cli" pnpm build:cli; then
  fail_count=$((fail_count + 1))
else
  if postgres_ready; then
    run_check "单元与集成测试" "pnpm test" pnpm test || fail_count=$((fail_count + 1))
    # 用例统计写进证据，避免用「全部通过」替代数字。
    summary="$(grep -E '^ *Tests +[0-9]+' "$LOG" | tail -n 1 | sed -E 's/^ +//')"
    files="$(grep -E '^ *Test Files +[0-9]+' "$LOG" | tail -n 1 | sed -E 's/^ +//')"
    if [ -n "$summary" ] || [ -n "$files" ]; then
      evidence[${#evidence[@]} - 1]="exit 0; ${files}; ${summary}"
    fi
  else
    record "单元与集成测试" "BLOCKED" "pnpm test" \
      "PostgreSQL 不可达（$(dsn_host "$DSN"):$(dsn_port "$DSN")）；集成用例会失败而不是 SKIP"
    blocked_count=$((blocked_count + 1))
  fi
fi

run_check "技能哈希校验" "pnpm verify:skills" pnpm verify:skills \
  || fail_count=$((fail_count + 1))

if [ "$GATE_E2E" = "1" ]; then
  if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ "${BK_E2E_SHARE_CREDENTIALS:-0}" != "1" ]; then
    record "真实模型 E2E（E-09）" "BLOCKED" "BK_E2E=1 node scripts/e2e-agent.mjs" \
      "DEEPSEEK_API_KEY 未设置，且未开启 BK_E2E_SHARE_CREDENTIALS"
    blocked_count=$((blocked_count + 1))
  else
    if run_check "真实模型 E2E（E-09）" "BK_E2E=1 node scripts/e2e-agent.mjs" \
      env BK_E2E=1 node scripts/e2e-agent.mjs; then
      # 证据取脚本自己的结论，而不是一句 exit 0。
      goal="$(sed -nE 's/.*"goalId": "([^"]+)".*/\1/p' "$LOG" | head -n 1)"
      hints="$(sed -nE 's/^ *"(run_step|remediate|await_approval|done)",?$/\1/p' "$LOG" | sort -u | paste -sd, -)"
      bytes="$(sed -nE 's/.*"bytes": ([0-9]+).*/\1/p' "$LOG" | head -n 1)"
      evidence[${#evidence[@]} - 1]="exit 0; goal=${goal:-unknown}; hint=${hints:-?}; artifact=${bytes:-?} bytes"
    else
      fail_count=$((fail_count + 1))
    fi
  fi
fi

printf '\n| 检查项 | 结果 | 命令 | 证据 |\n|---|---|---|---|\n'
for index in "${!names[@]}"; do
  printf '| %s | %s | `%s` | %s |\n' \
    "${names[$index]}" "${results[$index]}" "${commands[$index]}" "${evidence[$index]}"
done

if [ "$fail_count" -gt 0 ]; then
  printf '\n结论：FAIL（%d 项失败）\n' "$fail_count"
  exit 1
fi
if [ "$blocked_count" -gt 0 ]; then
  printf '\n结论：BLOCKED（%d 项未执行；SKIP 与 BLOCKED 不计为 PASS）\n' "$blocked_count"
  exit 3
fi
printf '\n结论：PASS\n'
