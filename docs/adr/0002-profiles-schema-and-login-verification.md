# ADR 0002: profiles/mentor_students 스키마 및 로그인 인증 흐름 확정

## 상태
확정 (2026-07-16: `career_interest` 컬럼 타입만 ADR 0003으로 부분 수정됨 — 아래 profiles 절 참고)

## 배경
`docs/specs/auth-login.md`에서 학생 로그인은 학번+이름+비밀번호 3가지가 모두 일치해야 성공하도록, 관리자 로그인은 코드+비밀번호 2가지로 확정됐다. CLAUDE.md 5장은 `profiles`, `mentor_students` 테이블의 필드를 정의하고 있으나 아직 실제 SQL로 구체화되지 않았다. 이 ADR은 두 테이블의 실제 컬럼/제약, "이름까지 일치해야 로그인 성공" 검증을 어느 레이어에서 수행할지, virtual email 변환 규칙, 에러 메시지 분기, 데모 계정 시딩 방식을 확정한다.

## 결정 (스키마 변경 포함)
전체 SQL은 `docs/db/schema.sql`. 요약:

### profiles

> **2026-07-16 갱신 (ADR 0003)**: 아래 `career_interest text`는 **`career_track` enum으로 좁혀졌다** (학생 홈의 계열 매칭 추천이 성립하려면 `programs.career_track`과 값 공간이 같아야 하기 때문). nullable은 유지된다. 이 컬럼 타입 1건 외에 이 ADR의 나머지 결정(가상 이메일 규칙, 로그인 검증 흐름, RLS)은 전부 그대로 유효하다 — supersede가 아니라 부분 수정이다. 현재 스키마는 `docs/db/schema.sql`, 근거는 `docs/adr/0003-programs-schema-and-career-track-taxonomy.md` 참고.

- `id uuid primary key references auth.users(id) on delete cascade` — Supabase Auth 계정과 1:1
- `role user_role not null` (enum: `student` / `admin`)
- `code text not null unique` — 학번(`10718`) 또는 관리자코드(`ADM-0001`). **원본 케이싱 그대로 저장** (표시용)
- `name text not null`
- `points_balance integer not null default 0`, `points_total integer not null default 0`, `currency_balance integer not null default 0`, `career_interest text` — CLAUDE.md 5장 필드 그대로. 이번 로그인 기능에서는 사용하지 않지만, profiles가 학생/관리자 공통 테이블로 지금 처음 생성되는 시점이라 함께 정의해 이후 기능에서 재마이그레이션이 필요 없게 한다 (임의 필드 추가 아님 — CLAUDE.md에 이미 정의된 필드).
- `created_at timestamptz not null default now()`

### mentor_students
- `admin_id uuid references profiles(id)`, `student_id uuid references profiles(id)`, `unique(admin_id, student_id)`
- role 정합성("admin_id는 실제 admin, student_id는 실제 student")은 DB CHECK/트리거로 강제하지 않고 시딩 스크립트 책임으로 둔다. 관리자 1명·학생 5명 규모의 데모 데이터라 트리거까지 넣는 건 과설계로 판단.

### 가상 이메일 변환 규칙
```
buildVirtualEmail(code) = code.trim().toLowerCase() + '@accumu.local'
```
- **소문자 정규화 이유**: Supabase Auth(GoTrue)는 이메일을 내부적으로 대소문자 구분 없이 다루는 경향이 있어, 관리자 코드처럼 대문자가 섞인 값(`ADM-0001`)을 그대로 로컬파트에 쓰면 시딩 시점과 로그인 시점의 케이싱이 어긋날 여지가 있다. 항상 소문자로 변환해 생성/조회하면 이 문제를 원천 차단한다.
- 이 함수는 **순수 함수 하나**로 `src/lib/virtualEmail.js`에만 구현하고, 로그인 코드(`authService.js`)와 Node 시딩 스크립트(`scripts/seed-accounts.mjs`) 양쪽이 동일 로직을 import해서 쓴다. 이중 구현으로 인한 드리프트(둘이 몰래 달라지는 것)를 방지하기 위함.
- `profiles.code`는 원본 케이싱(`ADM-0001`)을 그대로 보존한다 — 화면 표시용 값과 이메일 생성용 값을 분리.

### 로그인 검증 흐름 — 레이어 및 에러 메시지 확정
pm-agent 스펙의 절차를 그대로 채택하되, **역할(role) 불일치와 이름(name) 불일치는 서로 다른 에러 메시지를 쓴다**는 점을 명확히 한다 (스펙 원문에서 두 종류 문구가 섞여 있어 혼동 여지가 있었음 — 이 ADR에서 확정):

| 케이스 | 메시지 | 비고 |
|---|---|---|
| 자격증명 자체 오류 (signInWithPassword 실패, 학생 탭) | "학번/이름 또는 비밀번호를 확인해주세요" | Supabase 원본 에러 미노출 |
| 자격증명 자체 오류 (signInWithPassword 실패, 관리자 탭) | "관리자 코드 또는 비밀번호를 확인해주세요" | 〃 |
| signIn은 성공했지만 `profile.role`이 선택 탭과 다름 | "선택한 유형과 계정이 일치하지 않습니다" | 학생↔관리자 계정 교차 사용 케이스 전용, 위와 별개 메시지 |
| signIn·role은 통과했지만 (학생 탭만) `profile.name`이 입력값과 다름 | "학번/이름 또는 비밀번호를 확인해주세요" | 자격증명 오류와 **동일 문구** (무엇이 틀렸는지 구분 안 함, 스펙 요구사항) |

처리 순서 (둘 다 signOut을 반드시 실행 후 에러 반환):

```
loginStudent({ studentId, name, password }):
  1. email = buildVirtualEmail(studentId)
  2. signInWithPassword({ email, password })
     실패 → throw "학번/이름 또는 비밀번호를 확인해주세요" (세션 없음, signOut 불필요)
  3. profiles에서 본인 행 select (auth.uid() = id, RLS profiles_select_own 허용)
     조회 실패/행 없음 → signOut() 후 throw "학번/이름 또는 비밀번호를 확인해주세요" (방어적 fallback)
  4. profile.role !== 'student' → signOut() 후 throw "선택한 유형과 계정이 일치하지 않습니다"
  5. profile.name.trim() !== name.trim() → signOut() 후 throw "학번/이름 또는 비밀번호를 확인해주세요"
  6. 위 전부 통과 → profile을 AuthContext에 세팅, 성공 반환

loginAdmin({ code, password }):
  1~3. 동일 (에러 문구만 관리자용으로 치환)
  4. profile.role !== 'admin' → signOut() 후 throw "선택한 유형과 계정이 일치하지 않습니다"
  (이름 대조 단계 없음 — 관리자 탭은 코드+비밀번호 2-factor)
  5. 통과 → profile 세팅, 성공 반환
```

역할 검사(4번)가 이름 검사(5번)보다 먼저 실행되는 이유: 관리자 계정 자격증명을 학생 탭에 입력한 경우(둘 다 비밀번호가 `accumu2026`으로 동일해 실제로 signIn 자체는 성공함) 이름 필드 내용과 무관하게 "유형 불일치" 메시지가 나가야 스펙 시나리오 4 및 인수조건과 일치한다.

**왜 이 검증을 DB/서버가 아니라 클라이언트 레이어(`src/lib/authService.js`)에서 하는가**: `signInWithPassword`는 GoTrue가 직접 처리하는 호출이라, 이름까지 맞아야 세션을 내주게 만들려면 Edge Function으로 감싸는 프록시가 필요하다. 이 프로젝트 성격(1인 시연용 프로토타입, 실제 공격 방어보다 UX/로직 정확성이 목적)을 고려하면 그 정도 인프라는 과설계다. 코드+비밀번호를 아는 시점에 이미 해당 계정 자격증명을 보유한 것이므로, 이름 불일치 시 짧게 세션을 냈다가 즉시 지우는 절충은 이 스코프에서 허용 가능한 리스크로 판단한다 (Accepted risk로 문서화).

### 데모 계정 시딩
`scripts/seed-accounts.mjs` (Node, ESM):
1. `.env.seed`에서 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 로드 → service-role 클라이언트 생성
2. `docs/specs/auth-login.md`의 "확정된 데모 계정" 표(학생 5 + 관리자 1)를 순회하며 각 계정마다:
   - `supabase.auth.admin.createUser({ email: buildVirtualEmail(code), password: 'accumu2026', email_confirm: true })` → `user.id` 확보
   - `supabase.from('profiles').insert({ id: user.id, role, code, name })`
3. 학생 5명의 `user.id`를 모아, 관리자 `user.id` 1개와 짝지어 `mentor_students`에 5행 insert (관리자 1명이 학생 5명 전원 담당)
4. 재실행 안전성은 이번 스코프 필수 아님 — 신규 Supabase 프로젝트에 1회 실행 전제. 재실행 시 중복 이메일 에러로 중단되는 것을 기본 동작으로 두고, "이미 있으면 skip" 방어 로직 추가 여부는 backend-agent 재량 (과설계 방지 차원에서 필수 요구 아님으로 명시).
5. 저장 위치: `scripts/seed-accounts.mjs` (ADR 0001 폴더 구조와 일치)

> **2026-07-16 갱신 (ADR 0003)**: 위 2번의 profiles insert에 `career_interest`가 추가된다. 앱에 계열 선택 UI가 없고(마이페이지 스펙) `profiles`에 update 정책도 없어, 시딩이 이 값의 **유일한 입력 경로**이기 때문이다. 값 배정은 ADR 0003 "시드 설계" 참고.

## RLS/권한 영향
- `profiles`: RLS 활성화, select 정책은 **본인 행만**(`auth.uid() = id`, 정책명 `profiles_select_own`) — 학생이 다른 학생의 이름/포인트/진로 관심사 등을 절대 볼 수 없다. 로그인 시 role/name 대조에 필요한 최소 권한만 부여했다.
- `profiles`에 client 대상 insert/update/delete 정책은 이번 스코프에 전혀 없음(계정 생성은 service_role 시딩으로만 가능) → "회원가입 UI 없음" 원칙과 일치. 학생이 자기 `role`이나 `points_balance` 등을 직접 고쳐쓰는 경로도 이 시점에 원천 차단됨.
- `mentor_students`: RLS 활성화하되 이번 스코프는 정책 0개(기본 전체 거부). 시딩은 service_role이라 영향 없음. 학생/관리자 어느 쪽도 이 테이블을 앱에서 조회할 수 없어 "담당 학생 매핑 노출" 리스크가 이번 변경으로는 생기지 않는다. (다음 기능 "담당 학생 아카이브"에서 admin 전용 select 정책을 별도 ADR로 추가 예정.)
- **재검토 결론**: 이번 변경으로 학생이 다른 학생의 개인정보(이름, 학번, 포인트 등)에 접근할 경로는 없다 — select 정책이 `auth.uid() = id` 하나뿐이라 확인됨. 관리자도 이번 스코프에서는 자기 자신 행만 조회 가능하고 담당 학생 조회는 아직 미구현 — 로그인 기능 자체는 CLAUDE.md의 "관리자 기능 3종"에 해당하지 않으므로 이 범위가 맞다.

## 대안으로 고려했던 것
- **Postgres 함수(RPC)/트리거로 이름 대조**: Supabase Auth의 비밀번호 검증이 GoTrue 내부(`auth` 스키마, bcrypt)에 있어, SQL에서 재검증하려면 비밀번호 해시 로직을 직접 다뤄야 해 실익보다 복잡도가 큼. 기각.
- **Edge Function으로 로그인 전체를 프록시**: 이름까지 검증한 뒤 세션을 발급하는 "정석적" 방법이지만, Supabase 프로젝트조차 아직 없는 초기 단계에 Edge Function 배포/관리까지 스코프를 넓히는 건 "1인 시연 프로토타입" 원칙에 안 맞음. 기각 (향후 필요시 재검토 가능하도록 이 ADR에 남김).
- **profiles.code를 role별 두 컬럼(student_id, admin_code)으로 분리**: CLAUDE.md 5장이 이미 단일 `code` 필드로 정의했고, 관리자/학생이 같은 테이블을 쓰는 구조상 통합 컬럼이 더 단순함. 기각.
- **mentor_students에 role 정합성 CHECK/트리거 추가**: 데모 데이터가 시딩 스크립트로만, 관리자 1명·학생 5명 규모로만 채워져 실익이 적어 기각. 스크립트 리뷰로 충분.
- **역할 불일치와 이름 불일치를 완전히 동일한 문구로 통일**: 스펙 원문 해석상 가능한 대안이었으나, 시나리오 4/인수조건에 "선택한 유형과 일치하지 않습니다" 문구가 명시적으로 별도 등장해 구분하는 쪽으로 확정.

## 영향받는 코드 위치
- `docs/db/schema.sql` — profiles/mentor_students DDL + RLS 정책 (반영 완료, backend-agent는 이를 실제 마이그레이션 파일로 변환)
- `scripts/seed-accounts.mjs` — **backend-agent** 구현 (본 ADR의 시딩 절차 그대로)
- `src/lib/virtualEmail.js`, `src/lib/authService.js`, `src/context/AuthContext.jsx` — **frontend-agent** 구현 (ADR 0001 폴더 구조, 본 ADR의 처리 순서/에러 메시지 표 그대로)
- `src/pages/LoginPage.jsx` — 필드 리셋 규칙(비밀번호만 초기화)과 문구는 `docs/specs/auth-login.md` 그대로 따름, 에러 메시지 소스는 본 ADR의 표
