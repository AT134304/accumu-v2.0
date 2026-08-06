# Accumu × Claude Code 팀 세팅 키트 (v2 — 실제 작동 프로토타입)

React + Supabase 기반으로 "진짜 작동하는" Accumu를 만들기 위한 5개 에이전트 구성입니다. 기존 정적 HTML 프로토타입 대비 백엔드(인증·DB·QR 카메라 인증)가 새로 생기면서, 에이전트를 4개 → 5개로 확장했습니다 (backend-agent 추가).

## 설치 방법

1. 이 zip을 풀어서 나온 내용을 프로젝트 루트에 그대로 덮어씌우세요.
   - `CLAUDE.md` → 프로젝트 루트 (기존 v1 CLAUDE.md가 있다면 이 파일로 교체)
   - `.claude/agents/*.md` → 5개 에이전트 정의 (pm, architect, backend, frontend, qa)
   - `docs/specs/`, `docs/adr/`, `docs/db/` → 앞으로 쌓일 산출물용 빈 폴더
2. 기존 `Accumu_prototype.html`과 `Accumu_기획서_v2.docx`가 있다면 같은 프로젝트 루트에 함께 두세요. frontend-agent와 pm-agent가 참고합니다.
3. 터미널에서 프로젝트 폴더로 이동 후 `claude` 실행. `/agents`로 5개 에이전트 등록 확인.

## 기본 흐름

```
pm-agent (스펙 정리)
   ↓
architect-agent (데이터/RLS 설계, 필요시)
   ↓
backend-agent (Supabase 스키마·Auth·RLS·QR 토큰 로직)
   ↓
frontend-agent (React 화면 구현)
   ↓
qa-agent (원칙·권한·데이터 정합성 검증)
```

사용 예:
```
pm-agent 써서 "관리자 QR 스캔 화면" 스펙부터 정리해줘
architect-agent로 QR 토큰 테이블/검증 로직 설계하고 ADR 남겨줘
backend-agent로 방금 설계한 스키마·RLS 구현해줘
frontend-agent로 관리자 QR 스캔 화면 만들어줘
qa-agent로 방금 작업 검증해줘, 특히 권한 쪽 꼼꼼히 봐줘
```

간단한 UI 수정(색상, 문구, 여백)은 pm-agent 없이 바로 frontend-agent를 불러도 됩니다.

## 시연 환경 (QR 입·퇴장 인증 — `docs/specs/qr-dual-auth.md` 확정 E-1)

**카메라는 `http://localhost` 또는 HTTPS에서만 열립니다.** `http://192.168.x.x`는 보안 컨텍스트가 아니라 브라우저가 `getUserMedia`를 차단합니다. 이 전제를 모르면 폰에서 관리자로 로그인해 스캔을 시도하다 "버그"로 오인하게 됩니다.

공식 시연 조합(W-1) — 순수 로컬에서 성립하는 유일한 조합입니다.

```
npm run dev -- --host      # LAN 노출
```

| 역할 | 접속 주소 | 카메라 |
|---|---|---|
| **학생** (QR 표시) | 폰 브라우저 `http://192.168.x.x:5173` | 필요 없음 — QR을 표시만 함 |
| **관리자** (QR 스캔) | PC `http://localhost:5173` | PC 웹캠 |

폰 화면의 QR을 PC 웹캠에 비추면 인증됩니다. 폰과 PC는 다른 기기라 Supabase 세션이 분리되므로 1인 시연이 가능합니다.

- **웹캠 인식이 실패하면**: 스캔 화면 하단 "카메라를 쓸 수 없나요?"를 펼쳐 학생 QR 아래 코드를 직접 입력하세요. **카메라와 완전히 같은 검증 함수**를 타므로 만료·1회용·입퇴장 2회 인증이 그대로 적용됩니다.
- **입장·퇴장 2회 인증**은 단순화하지 않습니다. 학생 화면은 10초 폴링으로 인증 결과를 자동 반영합니다.
- 시연 리셋은 마이그레이션 하단의 절차(`participations` 삭제 + `profiles.points_*` 0으로 복구)를 함께 실행해야 잔액과 원장이 어긋나지 않습니다.

## 시연 메모 — 관리자 프로그램 관리 (`docs/specs/admin-programs.md`)

- **등록은 초안(미게시)으로 저장됩니다.** 저장 직후에는 학생 화면에 보이지 않고, 목록에서 **"올리기"**를 눌러야 공개됩니다(확정 D). 목록이 날짜 축 정렬이라 새 행은 맨 위가 아니라 **날짜 위치**에 꽂히며, 저장 직후 그 행으로 자동 스크롤·하이라이트됩니다.
- **새로 등록한 프로그램은 `popularity = 0`이라 학생 "프로그램 선택" 화면의 기본 정렬(인기순)에서 맨 뒤에 붙습니다.** 시연 때는 정렬을 **최신순**으로 바꾸면 맨 앞에 옵니다(스펙 이슈 3 — 알려진 열화, 수용).
- **"내리기"는 삭제가 아닙니다.** `is_published=false` 토글이며 앱에 삭제 경로가 없습니다(delete 정책 0개). 이미 신청한 학생의 QR 발급→입장→퇴장→포인트 지급은 게시중단 후에도 그대로 동작합니다(ADR 0005 결정 7-4).
- 이 화면이 만든 프로그램의 정리는 SQL 콘솔(`service_role`) 전용입니다.

## 배포 (Vercel)

**SPA 라우팅 설정이 없으면 로그인이 아예 안 된다.** `vercel.json`의 rewrite가 그것을 담당한다.

- 이 앱은 클라이언트 라우팅(react-router)을 쓰므로 `/signup`, `/student/archive`, **`/auth/naver`** 같은 주소로 **직접 진입**하는 경우가 있다. rewrite가 없으면 Vercel이 그 경로의 파일을 찾다가 404를 낸다.
- 특히 **네이버 로그인은 `/auth/naver`로 되돌아오는 것이 흐름의 일부**라, 404가 나면 로그인 자체가 성립하지 않는다.
- `public/_redirects`는 **Netlify 형식**이라 Vercel에서는 아무 효과가 없다. 지우지는 않았지만(Netlify 배포 대비) Vercel에서는 `vercel.json`이 유일하게 동작하는 설정이다.

**Vercel 환경변수 3개** (Project → Settings → Environment Variables). 빌드 시점에 번들로 들어가므로 **값을 바꾸면 재배포해야 반영된다.**

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_NAVER_CLIENT_ID
```

**네이버 Callback URL은 origin 마다 등록해야 한다** (네이버 개발자센터 → 애플리케이션 → API 설정).
구글·카카오와 달리 네이버는 Supabase 콜백이 아니라 **앱 주소로 직접** 돌아오기 때문이다.

```
http://localhost:5173/auth/naver          ← 로컬 개발
https://<배포주소>/auth/naver              ← Vercel
```

`service_role`이 필요한 `naver-auth` Edge Function은 Vercel이 아니라 **Supabase에 배포**한다(ADR 0009).

```bash
npx supabase secrets set NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=...
npx supabase functions deploy naver-auth --no-verify-jwt
```

## 구글 로그인 설정 (ADR 0010)

**네이버와 정반대다.** 네이버는 앱 주소로 돌아오지만 **구글은 Supabase 콜백으로 돌아온다.** 이걸 반대로 넣는 게 가장 흔한 실수다.

| | 네이버 | 구글 |
|---|---|---|
| 리디렉션 URI 등록 위치 | 네이버 개발자센터 | Google Cloud Console |
| 등록하는 값 | **앱 주소** `https://<앱>/auth/naver` | **Supabase 콜백** `https://<project-ref>.supabase.co/auth/v1/callback` |
| 프런트 환경변수 | `VITE_NAVER_CLIENT_ID` 필요 | **없음** |
| 서버 코드 | Edge Function `naver-auth` | **없음** |

설정 순서:

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)) → 프로젝트 생성 → API 및 서비스 → OAuth 동의 화면 (External, 앱 이름·지원 이메일만 채우면 됨)
2. 사용자 인증 정보 → 사용자 인증 정보 만들기 → **OAuth 클라이언트 ID** → 웹 애플리케이션
   - 승인된 리디렉션 URI: `https://<project-ref>.supabase.co/auth/v1/callback`
3. **Supabase** → Authentication → Providers → **Google** 토글 ON → 2단계에서 받은 Client ID / Client Secret 붙여넣기 → Save
4. **Supabase** → Authentication → **URL Configuration**
   - Site URL: 배포 주소
   - Additional Redirect URLs: `http://localhost:5173/**`, `https://<배포주소>/**`
   - **이 단계를 빼먹으면 구글 인증은 성공하는데 앱으로 돌아오지 못한다.** 증상이 "로그인했는데 로그인 화면으로 되돌아옴"이라 원인을 찾기 어렵다.
5. 프런트 재배포 불필요 — 구글은 빌드에 박히는 값이 없다.

**설정이 안 됐을 때의 화면**: 버튼이 비활성 + "Supabase 대시보드의 Authentication → Providers 에서 Google 을 켜면 활성화됩니다" 안내. 앱이 `/auth/v1/settings`의 `external.google`을 읽어 판단하므로, 대시보드에서 켜면 **새로고침만으로 살아난다**(ADR 0010 결정 4).

**테스트 중 "액세스 차단됨" 이 뜨면**: OAuth 동의 화면이 테스트 모드라 그렇다. 테스트 사용자에 본인 구글 계정을 추가하거나 앱을 게시하면 된다.

## 참고

- `CLAUDE.md`가 5개 에이전트 전체가 공유하는 "헌법"입니다. 원칙·데이터 모델·디자인 시스템이 바뀌면 반드시 이 파일부터 수정하세요.
- 이번 버전부터 **권한(RLS) 문제**가 QA 체크리스트에 새로 들어갔습니다 — 백엔드가 생기면서 "학생이 관리자 기능에 접근 못 하게" 막는 게 중요해졌기 때문입니다.
- 관리자 기능은 의도적으로 3가지(프로그램 관리·담당 학생 아카이브 조회·QR 스캔)로 제한해뒀습니다. 학교 단위 대시보드 등은 향후 확장 항목(기획서 11장)이라 지금 스코프가 아닙니다.
