claude-switch() {
    local config_file="$HOME/.claude_config"
    if [[ ! -f "$config_file" ]]; then
        cat > "$config_file" << 'EOF'
ww|问问Code|sk-CAxInwdVREHlaEEJ9Fnd7ZRD9u1bHFvdZ8zdjs4ySAobTLt8|https://code.wenwen-ai.com
any|AnyRouter|sk-ah6coK1ZCu6jNeYkOEYiTyOE6InE0N7ecr24dmPDwcIQrXHG|https://anyrouter.top
kimi|月之暗面|sk-khspFMe5jT6JiFp8dPg2qOMQ7qfppv35blcEGlKTpee1EbOa|https://api.moonshot.cn/anthropic
tl|图灵|sk-PQII0yMHJXVwsaxXrtDRDXUCbJqauCqdf5WBSRrCanVssGRs|https://ccg.shiwoool.com
dd|DuckCode|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxNTMwLCJlbWFpbCI6ImxlZXNvbi5jaGVuQGdtYWlsLmNvbSIsInN1YiI6IjE1MzAiLCJpYXQiOjE3NTI4Mjk5NzR9.Dkjr8ZHeWmDVAUCeHzW0Wux0jtomKKSz-qQAXyd42vU|https://api.duckcode.top/api/claude
EOF
    fi

    if [[ $# -eq 0 ]]; then
        echo "可用配置："
        cut -d'|' -f1,2 "$config_file" | tr '|' ' - '
        return 0
    fi

    local line=$(grep "^$1|" "$config_file")
    if [[ -z "$line" ]]; then
        echo "未知别名：$1"; return 1
    fi

    IFS='|' read -r alias name token url <<< "$line"
    export ANTHROPIC_AUTH_TOKEN="$token"
    export ANTHROPIC_BASE_URL="$url"
    export CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    echo "已切换到：$name"
}

alias cs='claude-switch'
alias css='echo Alias:\ ${name:-N/A}\ Token:\ ${ANTHROPIC_AUTH_TOKEN:0:15}...\ URL:\ ${ANTHROPIC_BASE_URL}'


codex-switch() {
    local config_file="$HOME/.codex/config.toml"
    local auth_file="$HOME/.codex/auth.json"
    if [[ ! -f "$config_file" ]]; then
        mkdir -p "$HOME/.codex"
        cat > "$config_file" << 'EOF'
# 示例配置（按需修改）
model_provider = "crsdefault"
model = "gpt-5-codex"
preferred_auth_method = "apikey"

[model_providers.crsdefault]
name = "crsdefault"
base_url = "http://127.0.0.1:3000/openai"
wire_api = "responses"
requires_openai_auth = true
env_key = "CRS_OAI_KEY"
key = "sk-xxxxxxxx"
EOF
    fi

    # 列出可用的 model_providers.* 段
    if [[ $# -eq 0 ]]; then
        echo "可用 CRS："
        local entries
        entries=$(awk -F'[][]' '/^[ \t]*\[model_providers\.[^]]+\]/ {split($2,a,"."); if (a[2] != "") print " - " a[2]}' "$config_file")
        if [[ -z "$entries" ]]; then
            echo " - 未找到 CRS 配置"
        else
            printf '%s\n' "$entries"
        fi
        return 0
    fi

    local target="$1"
    # 校验目标 provider 是否存在（精确匹配段名，去除首尾空白后比较）
    if ! awk -v t="$target" '
        { s=$0; sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s) }
        s=="[model_providers." t "]" { found=1; exit }
        END { exit(found?0:1) }
    ' "$config_file"; then
        echo "未找到 CRS：$target"; return 1
    fi

    # 提取 base_url、key、env_key（进入精确目标段，遇到下一个 [ 开头段落退出）
    local base_url key env_key
    base_url=$(awk -v t="$target" '
        { s=$0; sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s) }
        s=="[model_providers." t "]" { inside=1; next }
        inside && $0 ~ /^[ \t]*\[/ { inside=0 }
        inside && $0 ~ /^[ \t]*base_url[ \t]*=/ {
            sub(/^[^=]+=[ \t]*/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit
        }
    ' "$config_file")
    key=$(awk -v t="$target" '
        { s=$0; sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s) }
        s=="[model_providers." t "]" { inside=1; next }
        inside && $0 ~ /^[ \t]*\[/ { inside=0 }
        inside && $0 ~ /^[ \t]*key[ \t]*=/ {
            sub(/^[^=]+=[ \t]*/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit
        }
    ' "$config_file")
    env_key=$(awk -v t="$target" '
        { s=$0; sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s) }
        s=="[model_providers." t "]" { inside=1; next }
        inside && $0 ~ /^[ \t]*\[/ { inside=0 }
        inside && $0 ~ /^[ \t]*env_key[ \t]*=/ {
            sub(/^[^=]+=[ \t]*/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit
        }
    ' "$config_file")

    if [[ -z "$base_url" || -z "$key" ]]; then
        echo "解析失败：$target 段缺少 base_url 或 key"; return 1
    fi

    # 导出环境变量（按你的要求固定为 CRS_OAI_KEY）
    export CRS_OAI_KEY="$key"
    export CODEX_BASE_URL="$base_url"

    # 更新顶层 model_provider = "<target>"
    local tmp
    tmp=$(mktemp)
    awk -v t="$target" '
        BEGIN{done=0}
        /^[ \t]*model_provider[ \t]*=/ && !done {
            print "model_provider = \"" t "\""; done=1; next
        }
        {print}
        END{
            if(!done){ print "model_provider = \"" t "\"" }
        }
    ' "$config_file" > "$tmp" && mv "$tmp" "$config_file"

    # 将 auth.json 的 key 置为 null（如果存在，防止 CLI 读取 OPENAI_API_KEY）
    if [[ -f "$auth_file" ]]; then
        tmp=$(mktemp)
        jq '(.providers.openai.apiKey? // .openai?.apiKey? // .apiKey?) = null' "$auth_file" 2>/dev/null > "$tmp" || cp "$auth_file" "$tmp"
        mv "$tmp" "$auth_file"
    fi

    echo "已切换到 Provider：$target"
    echo "CRS_OAI_KEY 导出为: ${CRS_OAI_KEY:0:12}..."
    echo "CODEX_BASE_URL=$CODEX_BASE_URL"
}

alias cds='codex-switch'
alias cdss='echo CRS_OAI_KEY:\ ${CRS_OAI_KEY:0:12}...\ BASE:\ ${CODEX_BASE_URL}'
