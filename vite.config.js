import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // [시연 전용] Cloudflare Tunnel(trycloudflare.com)로 접속할 때 Vite의 호스트 검사를 통과시킨다.
    //   폰과 노트북이 같은 네트워크에 없을 때 하나의 HTTPS 주소를 공유하기 위한 설정이며,
    //   HTTPS라야 관리자 QR 카메라 스캔이 열린다(http://192.168.x.x 는 보안 컨텍스트가 아니다 — 확정 E-1).
    //   이 항목이 없으면 터널 주소로 열 때 "Blocked request" 만 뜬다.
    allowedHosts: ['.trycloudflare.com'],
  },
});
