# ADR 0010 — 구글 로그인을 네이버와 함께 되살린다

## 상태
확정 (2026-08-06). **케빈 결정: ADR 0009 에서 걷어냈던 구글을 다시 붙인다. 네이버는 그대로 둔다.**
스펙: `docs/specs/auth-signup.md`(결정 F 재개정).

## 배경 — 이것은 결정 번복이다

ADR 0009(2026-07-31)는 "구글·카카오·페이스북을 전부 걷어내고 네이버만 구현한다"는 케빈 확정을 기록했다.
6일 뒤 네이버 가입이 실제로 동작하는 것을 확인한 뒤, 케빈이 **구글도 함께 제공**하기로 했다.

**되돌리는 비용이 낮은 이유를 먼저 적어둔다.** ADR 0009 는 구글을 "나쁘다"고 판단한 적이 없다.
당시 근거는 "네이버 하나로 좁힌다"는 선택이었고, 그때 **`handle_new_user()` 의 소셜 분기를 삭제하지
않고 남겨뒀다**(ADR 0009 "함께 개정하는 것" 3번째 줄). 그 판단이 지금 값을 한다 — 이 ADR 의
**마이그레이션은 0건**이다.

## 결정 1 — 구글은 Supabase 기본 경로(`signInWithOAuth`)로 붙인다

네이버에 Edge Function 이 필요했던 이유가 구글에는 하나도 해당하지 않는다.

| 항목 | 네이버 (ADR 0009) | **구글 (이 ADR)** |
|---|---|---|
| Supabase 제공자 지원 | ❌ 없음 | ✅ 있음 |
| `id_token`(OIDC) | ❌ 발급 안 함 | ✅ 발급 |
| 토큰 교환 주체 | **우리 Edge Function** (`service_role` 필요) | **Supabase** |
| 콜백 화면 | 필요 (`/auth/naver`, `NaverCallbackPage`) | **불필요** — `redirectTo: '/'` 로 돌아오면 `detectSessionInUrl` 이 세션을 만든다 |
| CSRF `state` | 우리가 만들고 대조 | Supabase 가 처리 |
| 새 서버 코드 | `supabase/functions/naver-auth/` | **0줄** |

그래서 구글 쪽 구현은 `authService.js` 의 `startGoogleLogin()` 하나로 끝난다.
**네이버 코드를 이 모양으로 줄일 수 없다는 점도 함께 기록한다** — 두 제공자의 코드량 차이는
게으름이 아니라 제공자 규격의 차이다.

## 결정 2 — 새 라우트를 만들지 않는다 (`redirectTo` 는 앱 루트)

`/auth/google` 같은 화면을 만들 이유가 없다. 구글에서 돌아올 때 이미 세션 재료가 URL 에 실려 있고,
supabase-js 가 그것을 자동으로 집는다. 이후 `/` 의 `RootRedirect` 가 role 에 맞는 홈으로 보낸다.

- **AuthContext 는 이미 준비돼 있다.** `onAuthStateChange` 의 소셜 분기(주석 "소셜 로그인 때문에
  필요한 분기")가 리다이렉트로 생긴 세션에서 프로필을 읽는다. 네이버 때 만든 코드가 그대로 쓰인다.
- `vercel.json` 의 SPA rewrite 도 그대로 유효하다 — 새 경로가 없으므로 추가 설정이 없다.

## 결정 3 — **구글로도 관리자가 될 수 없다** (ADR 0009 결정 3 과 동일한 가드)

| 가드 | 구현 |
|---|---|
| role 을 심을 자리가 없다 | 계정을 만드는 것은 Supabase Auth 다. 우리가 `createUser` 를 부르지 않으므로 metadata 에 `role`/`code`/`invite` 를 넣을 자리 자체가 없다 |
| 트리거가 고정한다 | 구글 계정은 `raw_app_meta_data.provider = 'google'` 이라 `handle_new_user()` 의 **(b) 소셜 분기**를 탄다 → `role='student'`, `account_type='personal'`, `code` 는 `P-XXXXXX` 자동 발급 (마이그레이션 `20260731140000`) |
| 관리자 승격 불가 | 관리자는 `invite_codes(kind='admin')` 를 입력하는 **이메일 가입 경로에서만** 만들어진다. 소셜 경로에는 그 입력이 존재하지 않는다 |
| 담당 배정 불가 | `mentor_students` 를 건드리지 않는다. 학교 연동은 로그인 후 학생 본인이 `link_school_account()` 로만 한다 |
| 포인트 불가 | `profiles.points_*` 를 SET 하지 않는다 (절대 원칙 1·3) |

**규율**: 소셜 버튼을 **학생 탭 + 개인 계정 밖에 두려는 변경**은 이 표를 다시 검토해야 한다.
관리자 탭이나 학교 계정에 두는 순간, 화면이 "되지 않는 경로"를 약속하게 된다.

## 결정 4 — 활성 여부는 서버에 묻는다 (VITE_ 플래그를 늘리지 않는다)

네이버는 `VITE_NAVER_CLIENT_ID` 주입 여부로 판단한다(클라이언트가 그 값을 직접 쓰기 때문).
구글은 다르다 — 켜짐 여부를 아는 것은 **Supabase 대시보드**다.

| 안 | 판단 |
|---|---|
| 4-1 (기각) `VITE_GOOGLE_ENABLED` 플래그 추가 | 대시보드에서 껐는데 버튼은 살아 있는 상태가 만들어진다. **화면이 거짓말을 한다.** 설정이 두 곳으로 갈라지는 것 자체가 비용이다 |
| 4-2 (기각) 항상 활성화하고 실패하면 문구 표시 | 이 프로젝트는 "없는 기능을 눌리게 두지 않는다"를 이미 네이버에서 택했다(`SocialLogin` 주석). 제공자마다 규칙이 달라질 이유가 없다 |
| **4-3 (채택) GoTrue 공개 설정(`/auth/v1/settings`)의 `external.google` 을 읽는다** | 서버의 사실을 그대로 쓴다. 모듈 수준에서 1회만 조회해 캐시하고, 실패하면 "꺼짐"으로 본다(fail-closed) |

## 결정 5 — 버튼 블록을 컴포넌트가 소유한다 (`NaverLoginButton` → `SocialLogin`)

제공자가 둘이 되면서 "또는" 구분선을 누가 그리는가가 문제가 됐다. 버튼마다 그리면 두 번 나오고,
한쪽이 그리면 그쪽이 꺼졌을 때 사라진다. **블록이 구분선을 소유한다.**

- `src/components/NaverLoginButton.jsx` → **`src/components/SocialLogin.jsx`** (삭제 후 대체)
- `src/styles/Naver.css` 는 **네이버에만 있는 것**(콜백 화면)만 남기고, 버튼·구분선은 `Social.css` 로 이동
- `mode="login" | "signup"` 으로 문구만 갈린다 — 두 화면이 같은 부품을 쓴다

### 초록 금지 규칙(CLAUDE.md 8장)과의 관계
구글 마크의 4색에는 초록(#34A853)이 들어 있다. 네이버 #03C75A 와 **완전히 같은 성격**으로 다룬다 —
인용된 브랜드 자산이며, ① 그 버튼 하나에만 쓰고 ② 토큰으로 승격하지 않고 ③ 어떤 UI 의미로도
재사용하지 않는다. 이 세 줄은 `Social.css` 상단에 그대로 적혀 있다.

## 결정 6 — 로그인 화면의 진입 문제도 함께 고친다

네이버 가입은 되는데 **로그인 화면에서 소셜 버튼을 찾을 수 없는 문제**가 실제로 발생했다.

원인은 기본값이다. 가입 화면의 계정 종류 기본값은 `personal`(버튼이 보임), 로그인 화면은
`school`(버튼이 안 보임)이다. 소셜로 가입한 사람은 **전원** 개인 계정이므로, 로그인하러 오면
버튼이 사라진 것처럼 보인다.

- 버튼을 학교 계정에도 두는 것은 **기각** — 결정 3 의 가드를 화면에서 깨는 일이다.
- 대신 학교 계정 화면에 **개인 계정으로 건너가는 한 줄**을 둔다(`.social-hint`).
- 제공자 설정 여부로 그 줄을 감추지 않는다. 개인 계정은 이메일로도 만들어지므로 언제나 참이다.

## 케빈이 해야 하는 설정 (코드로 못 하는 것)

1. **Google Cloud Console** → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)
   - 승인된 리디렉션 URI: `https://wunnfwlgvbbjbbmjadmd.supabase.co/auth/v1/callback`
   - **앱 주소가 아니다.** 네이버(앱 주소로 직접 회신)와 반대라 헷갈리기 쉽다.
2. **Supabase** → Authentication → Providers → **Google** 활성화 + Client ID / Secret 입력
3. **Supabase** → Authentication → URL Configuration
   - Site URL: 배포 주소
   - Additional Redirect URLs: `http://localhost:5173/**`, `https://<배포주소>/**`
   - 이게 빠지면 구글 인증은 성공하는데 앱으로 못 돌아온다.
4. 프런트 환경변수 **추가 없음** — 구글은 `VITE_` 값을 쓰지 않는다.

## 결과

- 마이그레이션: **0건**
- 새 라우트: **0개**
- 새 관리자 기능: **0개** (원칙 6 유지)
- 새 프런트 환경변수: **0개**
- 변경: `authService.js`(+구글 3함수), `SocialLogin.jsx`(신규), `Social.css`(신규),
  `Naver.css`(축소), `LoginPage.jsx`, `SignupPage.jsx`, `NaverLoginButton.jsx`(삭제)
