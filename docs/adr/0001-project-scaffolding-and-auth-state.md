# ADR 0001: Vite/React 프로젝트 스캐폴딩 및 인증 상태관리 구조

## 상태
확정

## 배경
저장소에 코드가 전혀 없는 상태에서 로그인 기능(`docs/specs/auth-login.md`)을 구현하려면, backend-agent(스키마/시딩)와 frontend-agent(화면)가 서로 어긋나지 않게 작업을 시작할 수 있도록 프로젝트 골격 — 빌드 도구, 라우팅, 인증 상태를 어디서 어떻게 들고 있을지 — 이 먼저 정해져야 한다. pm-agent 스펙도 "프로젝트 스캐폴딩 선행 필요"를 명시했다.

Supabase 프로젝트는 케빈이 지금 막 생성 중이라 URL/anon key가 아직 없다. 이 ADR은 실제 연결 없이 확정 가능한 구조적 결정만 다룬다.

## 결정

### 1. 빌드 도구 / 언어
Vite + React, 템플릿은 `react` (JavaScript, TypeScript 아님). 화면 수가 적은 프로토타입 초기 단계에서 타입 시스템 설정/유지 비용보다 빠른 반복이 우선이라고 판단. 코드량이 적은 지금 시점이 전환 비용이 가장 낮으므로, 케빈이 포트폴리오 제출 전 TS로 바꾸고 싶다면 언제든 전환 가능 (열린 선택지로 남김, 아래 "옵션" 참고).

### 2. 라우터
`react-router-dom` (최신 안정 버전), classic `<BrowserRouter>` + `<Routes>`/`<Route>` API. v7의 data router(loader/action) 방식은 화면 2~3개짜리 로그인 스코프에 과함.

라우트 테이블:
| 경로 | 컴포넌트 | 접근 조건 |
|---|---|---|
| `/login` | `LoginPage` | 이미 로그인+role 확정 상태면 즉시 자기 role 홈으로 리다이렉트 |
| `/student` | `ProtectedRoute(role="student")` → `StudentHomePage` | 세션 필요, role 불일치 시 조용히 리다이렉트 |
| `/admin` | `ProtectedRoute(role="admin")` → `AdminHomePage` | 세션 필요, role 불일치 시 조용히 리다이렉트 |
| `/` | `RootRedirect` | 세션/role에 따라 `/login` 또는 `/student`\|`/admin`으로 즉시 리다이렉트 |
| `*` | → `/login` 리다이렉트 | 알 수 없는 경로 처리 |

`/login`을 canonical 경로로 확정. 스펙 문구가 "`/login` 또는 `/`"를 함께 언급해 혼동 여지가 있어, `/`는 리다이렉트 전용으로 분리해 명확히 했다.

### 3. 인증 상태 관리
별도 상태관리 라이브러리(Redux, Zustand 등) 도입하지 않고 **React Context**(`AuthContext`)로 충분. 전역 상태가 `session`, `profile`, `loading` 3개뿐이라 과설계 회피.

- `AuthProvider`가 앱 최상단에서 마운트 시 `supabase.auth.getSession()`으로 세션 복구 → 세션 있으면 `profiles`에서 본인 행(`auth.uid() = id`) select → `profile` state 세팅.
- `supabase.auth.onAuthStateChange` 구독도 함께 유지 (signOut 등 이후 상태 변화 반영, 특히 이름/role 불일치로 인한 강제 signOut 케이스).
- `useAuth()` 커스텀 훅으로 `{ session, profile, loading, signInStudent, signInAdmin, signOut }` 노출.

### 4. 로그인 검증 로직 위치
3-factor(학번/이름/비밀번호) 검증 및 role 일치 검증은 **클라이언트 서비스 모듈** `src/lib/authService.js`에 위치. RLS는 "본인 행만 select 가능"만 보장하고, 대조·불일치 시 signOut은 애플리케이션 로직(JS)이 수행한다. (근거는 ADR 0002)

### 5. 폴더 구조
```
src/
  main.jsx
  App.jsx                     # <BrowserRouter> + <Routes> 정의
  lib/
    supabaseClient.js         # createClient(import.meta.env.VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
    virtualEmail.js           # buildVirtualEmail(code) 순수함수 — Node 시딩 스크립트와 로직 공유
    authService.js            # loginStudent(), loginAdmin(), logout()
  context/
    AuthContext.jsx            # AuthProvider + useAuth()
  routes/
    ProtectedRoute.jsx         # role 가드
    RootRedirect.jsx
  pages/
    LoginPage.jsx
    StudentHomePage.jsx        # 골격 화면
    AdminHomePage.jsx          # 골격 화면
  styles/
    tokens.css                 # CLAUDE.md 8장 디자인 토큰 (--ink, --bg, --brand 등)
scripts/
  seed-accounts.mjs            # Node, service_role 키로 데모 계정 6개 생성 (ADR 0002)
.env.local                     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (gitignore)
.env.local.example             # 커밋용 템플릿(플레이스홀더)
.env.seed                      # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (gitignore, 시딩 전용)
.env.seed.example               # 커밋용 템플릿
```

### 6. env 변수 처리
Vite는 `VITE_` 접두사가 붙은 변수만 클라이언트 번들에 노출한다. **service_role 키는 절대 `VITE_` 접두사를 붙이지 않고, 프런트 코드에서 import하지 않으며, 별도 파일 `.env.seed`에 두고 Node 시딩 스크립트에서만 읽는다.** `.env.local`, `.env.seed` 모두 `.gitignore`에 등록. 커밋용으로 `.env.local.example`, `.env.seed.example`만 남긴다(플레이스홀더 값).

이렇게 파일을 분리하는 이유: `.env.local` 하나에 anon key와 service_role key를 함께 두면, 나중에 실수로 `VITE_SUPABASE_SERVICE_ROLE_KEY`처럼 접두사를 잘못 붙이는 실수가 나올 여지가 있다. 파일 자체를 분리해 애초에 그 실수가 나올 물리적 경로를 없앤다.

### 7. ProtectedRoute 동작
- `loading === true` → 스피너/빈 화면 (판단 보류, 리다이렉트 하지 않음)
- 세션 없음 → `/login`으로 리다이렉트
- 세션은 있으나 `profile.role !== 요구 role` → 에러 노출 없이 자신의 role 홈(`/${profile.role}`)으로 조용히 리다이렉트 (스펙 요구사항, 에러 메시지 없음)

## RLS/권한 영향
이 ADR 자체는 라우팅/상태관리 구조라 RLS에 직접 영향 없음. `AuthProvider`가 `profiles`를 select하는 시점에 필요한 정책은 ADR 0002 및 `docs/db/schema.sql`에서 정의(`profiles_select_own`).

## 대안으로 고려했던 것
- **TypeScript 템플릿**: 타입 안정성은 좋으나 화면 수가 적은 초기 단계에서 설정/유지 비용 대비 이득이 적다고 판단해 보류. 코드량이 적은 지금이 전환 비용이 가장 낮으므로 언제든 전환 가능.
- **Redux/Zustand 등 상태관리 라이브러리**: 전역 상태가 세션 1개뿐이라 과설계. Context로 충분.
- **react-router v7 data router(loader/action) 방식**: 이후 프로그램 목록 등 화면이 늘어나면 고려할 수 있으나 로그인+골격 스코프에는 불필요한 복잡도.
- **로그인 경로를 `/` 하나로 통일**: 스펙 문구의 모호함을 그대로 남기지 않기 위해 `/login`을 canonical로 확정하고 `/`는 리다이렉트 전용으로 분리.

## 영향받는 코드 위치
- `src/App.jsx`, `src/routes/*`, `src/context/AuthContext.jsx`, `src/lib/*` — **frontend-agent**가 이 구조로 스캐폴딩
- `scripts/seed-accounts.mjs` — **backend-agent**가 ADR 0002 스펙대로 작성
- `.env.local.example`, `.env.seed.example` — 두 에이전트 모두 참고. 실제 값(URL/anon key/service role key)은 케빈이 Supabase 프로젝트 생성 후 채운다.

## 옵션 (케빈 확인 필요, 블로킹 아님)
- TypeScript로 시작할지 JavaScript로 시작할지 — 이 ADR은 JavaScript로 진행하되, 원하면 frontend-agent 착수 전에 바꿔도 무방.
