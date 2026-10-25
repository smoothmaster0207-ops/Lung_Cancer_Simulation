#!/bin/bash
# ==============================================================================
# 第4回「肺がん患者の看護」Clinical Reasoning Simulation
# インターネット公開起動スクリプト (start-public.sh)
# ==============================================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "===================================================="
echo "第4回「肺がん患者の看護」Clinical Reasoning Simulation"
echo "インターネット公開サーバーを起動しています..."
echo "===================================================="

# 既存プロセスのクリーンアップ
pkill -f "cloudflared tunnel --url http://localhost:3000" 2>/dev/null
pkill -f "node.*server.js" 2>/dev/null

LOG_FILE="/tmp/cloudflared_$$.log"
/opt/homebrew/bin/cloudflared tunnel --url http://localhost:3000 > "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

echo "インターネット公開用URLを発行中（数秒お待ちください）..."

PUBLIC_URL=""
for i in {1..30}; do
  PUBLIC_URL=$(grep -o "https://[-a-zA-Z0-9@:%._\+~#=]*\.trycloudflare\.com" "$LOG_FILE" | grep -v "api.trycloudflare.com" | head -n 1)
  if [ -n "$PUBLIC_URL" ]; then
    break
  fi
  sleep 1
done

if [ -n "$PUBLIC_URL" ]; then
  echo ""
  echo "****************************************************"
  echo "🎉 インターネット公開URLが正常に発行されました！"
  echo "****************************************************"
  echo "📱 学生用公開URL:  $PUBLIC_URL"
  echo "🔑 教員管理画面:    $PUBLIC_URL/admin"
  echo "（教員パスワード: lung2024 または cardiac2024）"
  echo "****************************************************"
  echo "※学生のスマートフォン（4G/5G/Wi-Fi）から上記URLを開くだけで演習に参加できます。"
  echo "※教員管理画面（$PUBLIC_URL/admin）もどのネットワークからでもアクセス可能です。"
  echo "※教員管理画面を開くと、上記URLのQRコードが自動表示されます。"
  echo "****************************************************"
  echo ""
  export PUBLIC_URL="$PUBLIC_URL"
else
  echo "⚠️ 公開URLの取得に時間がかかりました。ローカルモードで起動します。"
fi

# Nodeサーバー起動
node server.js &
NODE_PID=$!

trap "kill $TUNNEL_PID $NODE_PID 2>/dev/null; rm -f $LOG_FILE; echo 'サーバーを停止しました'; exit" INT TERM EXIT
wait $NODE_PID
