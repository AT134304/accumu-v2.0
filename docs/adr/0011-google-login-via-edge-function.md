# ADR 0011 — 구글도 Edge Function 으로 직접 교환한다 (ADR 0010 결정 1·2·4 번복)

## 상태
확정 (2026-08-06). **케빈 결정: 구글도 Supabase 제공자를 쓰지 말고 네이버처럼 직접 구현한다.**
ADR 0010 의 **결정 1(Supabase 기본 경로) · 결정 2(새 라우트 없음) · 결정 4(서버에 활성 여부 질의)를 대체**한다.
ADR 0010 의 **결정 3(권한 경계) · 결정 5(SocialLogin 블록) · 결정 6(로그인 화면 진입)은 그대로 유효하다.**

## 배경 — 기능이 아니라 운영의 문제였다

ADR 0010 은 "구글은 Supabase 가 지원하니 그 경로를 쓴다"고 판단했다. 코드량만 보면 옳다 —
`signInWithOAuth` 한 줄이면 되고 서버 코드가 0줄이었다. 그런데 그렇게 두면 **제공자마다 운영이 갈린다**:

| | 네이버 (ADR 0009) | 구글 (ADR 0010) |
|---|---|---|
| 설정하는 곳 | 네이버 개발자센터 + `supabase secrets` | Google Console + **Supabase 대시보드 2곳**(Providers, URL Configuration) |
| 리디렉션 URI | 앱 주소 | **Supabase 콜백** (반대 방향) |
| 고장났을 때 보는 곳 | Edge Function 로그 | 대시보드 토글 · URL 허용목록 |
| 활성 여부 판정 | `VITE_NAVER_CLIENT_ID` 유무 | `/auth/v1/settings` 조회 |

**시연 중에 소셜 로그인이 안 되면 어디를 봐야 하는지가 제공자마다 다르다.** 이 프로젝트는 1인이
학생·관리자를 오가며 실시간으로 시연하는 것이 목표다(CLAUDE.md 1장). 그 상황에서 "둘 중 어느
쪽 문제인지"를 먼저 판별해야 하는 구조는 그 자체로 비용이다.

케빈 결정: **두 제공자를 같은 경로로 통일한다.**

## 결정 1 — Edge Function `google-auth` 를 만든다 (naver-auth 와 같은 모양)

`code → token → 프로필 → 계정 → 매직링크 token_hash` 를 함수가 잇고, 프런트가 `verifyOtp` 로
세션을 만든다. **naver-auth 와 의도적으로 같은 구조다** — 한쪽을 고치면 다른 쪽도 같이 본다.

| 단계 | 네이버 | 구글 |
|---|---|---|
| 토큰 교환 | `GET nid.naver.com/oauth2.0/token` (쿼리) | `POST oauth2.googleapis.com/token` (form) |
| 프로필 | `openapi.naver.com/v1/nid/me` → `response.id` | `googleapis.com/oauth2/v3/userinfo` → `sub` |
| 이메일 없을 때 | `naver_{id}@accumu.local` | `google_{sub}@accumu.local` |
| 세션 | `generateLink('magiclink')` → `verifyOtp` | **동일** |

### `redirect_uri` 를 프런트에서 받지 않는다 — 두 함수의 유일한 차이

구글 토큰 엔드포인트는 authorize 때 쓴 `redirect_uri` 를 **똑같이** 요구한다(네이버는 요구하지 않는다).
그 값을 본문으로 받으면 ADR 0009 결정 3 의 "입력은 `code`/`state` 두 개뿐" 규율이 깨진다.

**채택**: 브라우저가 붙이는 **`Origin` 헤더**에서 서버가 직접 만든다 (`${origin}/auth/google`).
- 페이지 스크립트는 `Origin` 을 위조할 수 없다.
- 설령 비-브라우저 클라이언트가 위조해도, 구글이 "그 code 가 발급된 redirect_uri" 와 대조해 거부한다.
  **등록되지 않은 주소는 애초에 통과하지 못한다.**
- `Origin` 이 없는 환경(테스트 도구)을 위해 `GOOGLE_REDIRECT_URI` 시크릿을 대비책으로 둔다.

## 결정 2 — `/auth/google` 라우트를 만든다 (ADR 0010 결정 2 번복)

Supabase 가 교환해주지 않으므로 `code` 를 받을 화면이 필요하다. `NaverCallbackPage` 와 같은 모양의
`GoogleCallbackPage` 를 둔다. **StrictMode 이중 실행 가드(`ran` ref)도 같은 이유로 같이 있다** —
`code` 는 1회용이라 이 가드가 없으면 개발 모드에서 항상 실패한다.

`vercel.json` 의 SPA rewrite 가 이미 모든 경로를 덮으므로 배포 설정 변경은 없다.

## 결정 3 — 활성 여부는 `VITE_GOOGLE_CLIENT_ID` 유무로 판정한다 (ADR 0010 결정 4 번복)

ADR 0010 은 "서버가 아는 사실을 읽는다"며 `/auth/v1/settings` 를 조회했다. 그 논리는 **Supabase 가
제공자를 소유할 때만 성립한다.** 이제는 우리가 소유하므로, 클라이언트 ID 주입 여부가 곧 사실이다
— 네이버와 완전히 같은 판정이 된다. 로그인 화면에서 나가던 설정 조회 요청도 사라진다.

## 결정 4 — 권한 경계는 ADR 0009/0010 과 한 글자도 다르지 않다

| 가드 | 구현 |
|---|---|
| 입력이 두 개뿐 | 본문에서 읽는 값은 `code`, `state`. 이메일·이름·role·초대코드를 **받지 않는다** |
| 신원의 근거 | `oauth2/v3/userinfo` 응답의 `sub`/`email` 뿐. 유효한 구글 `code` 없이는 어떤 계정도 지목할 수 없다 |
| **role 을 심을 자리가 없다** | `createUser` 의 `user_metadata` 가 `{ name }` 하나뿐이라 `handle_new_user()` 의 "(c) 개인 이메일 가입" 분기를 타고 **언제나 `student`/`personal`** 이 된다 |
| 관리자 승격 불가 | 관리자는 `invite_codes(kind='admin')` 를 입력하는 이메일 가입 경로에서만 만들어진다 |
| 담당 배정 불가 | `mentor_students` 를 건드리지 않는다. 학교 연동은 로그인 후 `link_school_account()` 로만 |
| 포인트 불가 | `profiles.points_*` 를 SET 하지 않는다 |

**규율**: `google-auth` 에 인자를 추가하려는 변경은 이 표를 반드시 다시 검토해야 한다.
특히 `role`·`code`·`invite`·`student_id` 를 본문에서 읽기 시작하는 순간 보장이 전부 깨진다.
**`redirect_uri` 를 본문으로 옮기려는 변경도 같은 계열이다** — 결정 1 의 근거를 먼저 읽을 것.

## 결정 5 — 마이그레이션은 여전히 0건

`handle_new_user()` 의 (c) 분기가 이미 "metadata 에 name 만 있는 계정"을 학생·개인으로 만든다.
구글이 Supabase 제공자였을 때는 (b) 소셜 분기를, 지금은 (c) 개인 이메일 분기를 탄다.
**두 분기의 결과가 같도록 설계돼 있어서**(마이그레이션 `20260731140000`) DB 는 손대지 않는다.

## 비용 — 무엇을 잃었는지 정직하게 적는다

1. **`service_role` 을 쥔 무인증 함수가 하나 더 생겼다.** 표면이 2배다. 결정 4 의 가드가 두 곳에서
   유지돼야 한다.
2. **Supabase 가 대신 해주던 것을 우리가 짠다** — CSRF `state` 대조, 토큰 교환, 오류 분류.
3. **테스트해야 할 콜백 화면이 하나 더 늘었다.**

받은 것: 두 제공자의 설정·디버깅·판정 방식이 하나로 통일됐다. 시연 중 문제가 생기면
**볼 곳이 한 군데다** — Edge Function 로그.

## 케빈이 해야 하는 설정 (ADR 0010 에서 **바뀐다**)

> 이미 Supabase Providers 에서 Google 을 켜뒀다면 **꺼도 된다.** 이제 그 경로를 쓰지 않는다.
> URL Configuration 의 Additional Redirect URLs 도 구글 때문에 필요하지는 않다.

1. **Google Cloud Console** → 사용자 인증 정보 → OAuth 클라이언트 ID(웹)
   - 승인된 리디렉션 URI를 **앱 주소**로 바꾼다 (Supabase 콜백을 지운다):
     `http://localhost:5173/auth/google`, `https://<배포주소>/auth/google`
2. **클라이언트 ID → `.env.local` 의 `VITE_GOOGLE_CLIENT_ID`** (+ Vercel 환경변수)
3. **클라이언트 Secret → Edge Function 환경변수로만**
   ```bash
   npx supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
   npx supabase functions deploy google-auth --no-verify-jwt
   ```

## 결과

- 마이그레이션: **0건**
- 새 라우트: **1개** (`/auth/google`)
- 새 관리자 기능: **0개** (원칙 6 유지)
- 새 프런트 환경변수: **1개** (`VITE_GOOGLE_CLIENT_ID`)
- 변경: `supabase/functions/google-auth/`(신규), `GoogleCallbackPage.jsx`(신규),
  `authService.js`(구글 블록 교체), `SocialLogin.jsx`, `App.jsx`,
  `Social.css`(콜백 화면 흡수), `Naver.css`(삭제 — 두 콜백이 한 스타일을 쓴다)
