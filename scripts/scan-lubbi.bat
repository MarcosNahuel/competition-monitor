@echo off
:: Competition Monitor — Scan diario LUBBI
:: Programar con: Programador de Tareas de Windows → 8:00 AM

cd /d D:\OneDrive\GitHub\competition-monitor

set TENANT_1_NAME=lubbi
set TENANT_1_SUPABASE_URL=https://mgujyvzodnufbwqoijlc.supabase.co
set TENANT_1_SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ndWp5dnpvZG51ZmJ3cW9pamxjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzQ1NzQxNywiZXhwIjoyMDgzMDMzNDE3fQ.vX-vWwkpE9Rt92g5y3Q55AvhvvaDLK1DVJ9dmkWJ7JA
set TENANT_1_ML_SELLER_ID=1074767186
set TENANT_1_TENANT_ID=b9b24964-80ba-4db3-b9e3-5d94e0ca2b47
set TENANT_1_CHANNEL_ID=7a6e2c7d-ac5a-4568-89ec-1c5155ad40c9

echo [%date% %time%] Starting competition scan... >> logs\scan.log
call npx tsx src/cli.ts scan --tenant lubbi >> logs\scan.log 2>&1
echo [%date% %time%] Scan complete >> logs\scan.log
