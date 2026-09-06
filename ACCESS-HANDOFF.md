# gjc.gimso2x.com Cloudflare Access 수동 설정 핸드오프 (G003)

상태: 인프라 완료(G001/G002), Access 앱 등록만 사람이 Zero Trust 대시보드에서 수행 필요.
이유: 호스트에 Access-capable Cloudflare API 토큰이 없음 (cert.pem은 tunnel-scope cfut만 포함).

## 현재 상태 (2026-09-06 실측)
- 앱: http://127.0.0.1:3010 (health 200, gajae-app 2.0.0-beta.8)
- 서비스: systemctl --user gajae-app.service (active, linger=yes)
- 터널: e44c61e8-4dcc-49de-9160-f13e38d145a7 (cloudflared-wiki.service)
- DNS: gjc.gimso2x.com CNAME → 터널 (생성 완료)
- ⚠️ 현재 https://gjc.gimso2x.com 은 보호 없이 200 응답. G003 완료 전까지 임시 노출 상태.

## Zero Trust 대시보드 단계 (board.gimso2x.com과 동일하게)
1. one.dash.cloudflare.com → 접속: gimso2x@gmail.com
2. Zero Trust → Access → Applications → Add an application → Self-hosted
3. Application name: `gjc-app`
4. Application domain: `gjc.gimso2x.com` (zone: gimso2x.com)
5. Session Duration: board 앱과 동일값 (Applications에서 board.gimso2x.com 앱 클릭해 확인)
6. Next → Add a policy:
   - Policy name: `allow-gimso2x`
   - Action: **Allow**
   - Include → Selector: **Emails** → Value: `gimso2x@gmail.com`
   - (One-time PIN은 이메일 방식 기본 동작)
7. Next → Setup: 기본값 → Add application

## 검증
- 시크릿 창에서 https://gjc.gimso2x.com 접속 → Cloudflare Access challenge 리다이렉트 확인
- gimso2x@gmail.com OTP 로그인 → gajae-app UI 로드 확인
- 다른 계정 → 거부 확인
