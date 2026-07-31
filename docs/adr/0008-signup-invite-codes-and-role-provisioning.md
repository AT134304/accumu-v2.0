# ADR 0008 — 회원가입: 초대코드와 role 발급 경로

## 상태
확정 (2026-07-31). 스펙: `docs/specs/auth-signup.md`.

## 배경

이 앱의 권한 경계는 전부 `profiles.role` 한 컬럼에서 갈라진다.

| role | 열리는 것 |
|---|---|
| `admin` | 프로그램 insert/update(`programs_*_as_admin`), **`verify_participation_qr()` 호출 = 포인트 지급**, 담당 학생의 participations 조회 |
| `student` | 본인 참여 insert, QR 발급, 본인 원장·리뷰, 전환·계열 RPC |

지금까지 `profiles` 행을 만드는 경로는 **`service_role` 시딩 하나뿐**이었고(`insert` 정책 0개), 그래서 role 은 사람이 직접 정하는 값이었다. 회원가입은 **그 경로를 앱에 여는 일**이다.

**따라서 이 ADR 의 유일한 실질 질문은 "role 을 누가 정하는가"다.** 답이 "클라이언트"가 되는 순간 QR 스캔으로 포인트를 찍어내는 계정을 누구나 만들 수 있다.

### 이 ADR 이 의존하는 확정 (재논의 대상 아님)
- ADR 0002 — 가상 이메일(`{code}@accumu.local`), 로그인 시 role/name 대조, `profiles.code` unique
- ADR 0005 결정 7-2 — `mentor_students`는 **권한 경계 그 자체**이며 앱에 매핑 편집 UI를 만들지 않는다
- ADR 0007 결정 3-6 — **`profiles`의 update 정책은 0개**이고, 수정 경로는 `security definer` 함수뿐이다
- 스펙 결정 C — 초대코드는 **관리자별 고정, 표시 전용**(발급 UI 없음)

---

## 결정 1 — `profiles` insert 정책을 열지 않는다. **`auth.users` 트리거가 만든다**

| 안 | 판단 |
|---|---|
| 1-1 (기각) `profiles`에 insert 정책 + `with check (id = auth.uid())` | **role 을 클라이언트가 보낸다.** `with check` 에 `role='student'`를 박아도 관리자 가입 경로를 표현할 수 없고, 컬럼 grant 로 role 을 빼면 NOT NULL 위반이 된다. 무엇보다 **경계가 정책 한 줄에 얹혀 fail-open** 이다(ADR 0007 결정 4-3 과 같은 판단) |
| 1-2 (기각) signUp 후 클라이언트가 definer RPC 호출 | 두 단계가 **원자적이지 않다.** RPC 가 실패하면 `auth.users` 행만 남아 그 학번으로 **영원히 재가입 불가**한 유령 계정이 된다(같은 이메일 재사용 불가). 복구 경로를 또 만들어야 한다 |
| **1-3 (채택) `auth.users` after insert 트리거 `handle_new_user()`** | 계정 생성과 프로필 생성이 **같은 트랜잭션**이다. 트리거가 예외를 던지면 `auth.users` insert 까지 롤백되어 **유령 계정이 구조적으로 생기지 않는다.** role 판정이 DB 안에서 일어나므로 클라이언트가 개입할 지점이 없다 |

- `profiles`의 **insert/update/delete 정책은 계속 0개**다. ADR 0007 결정 3-6 의 표가 그대로 유지된다(아래 결정 5 에서 `account_type` 행만 추가).
- 트리거는 `security definer` + `set search_path = ''`.

### 1-1. 시딩 경로를 방해하지 않는다 (회귀 방지)

`scripts/seed-accounts.mjs`는 `auth.admin.createUser()` 로 계정을 만든 뒤 **자기가 직접 `profiles`를 insert** 한다. 트리거가 무조건 insert 하면 시딩이 23505 로 깨진다.

→ 트리거는 **`raw_user_meta_data`에 `code`·`name`이 없으면 아무것도 하지 않고 통과한다.** 시딩(metadata 없음)은 지금 그대로 동작하고, 앱 가입(metadata 있음)만 트리거를 탄다.

**단, 시드 스크립트에 한 필드가 추가된다 — 트리거 때문이 아니라 결정 5의 CHECK 때문이다.** `profiles_account_type_rule`이 "학생은 `account_type`이 NOT NULL"을 요구하므로, 직접 insert 하는 시딩 경로도 그 값을 실어야 한다(빠뜨리면 23514). 시드 학생 5명은 전원 `ADM-0001`에 매핑되므로 `'school'`이 사실과 일치한다. 트리거 경로와 시딩 경로가 **같은 불변식을 각자 만족시키는** 구조이고, 그 불변식의 소유자는 DB 제약이다.

---

## 결정 2 — role 은 **초대코드로만** 승격된다

```
raw_user_meta_data.role = 'admin'  →  invite_codes(kind='admin', is_active) 에 코드가 있어야 함
                                       없으면 22023 예외 → 가입 자체가 롤백
그 외 모든 값                       →  'student'
```

- **metadata 는 클라이언트가 자유롭게 넣을 수 있다.** 그래서 metadata 의 `role` 은 *신청*일 뿐이고, **승인은 DB 안의 `invite_codes` 조회**가 한다. 이 한 줄이 결정 1-1 을 기각한 이유와 같은 성질이다.
- **학생으로 대신 만들어주지 않는다.** 관리자 코드가 틀렸는데 학생 계정이 생기면, 사용자는 "가입됐다"고 믿고 관리자 기능이 없는 이유를 영원히 모른다. fail-closed 로 통일한다.
- 관리자 초대코드는 **앱에서 만들 수 없다**(insert 정책 0개). 만들 수 있게 하면 관리자가 관리자를 무한 증식시켜 경계 자체가 사라진다 — 발급 주체는 SQL 콘솔/시드뿐이다.

---

## 결정 3 — `invite_codes` 스키마와 정책

```sql
kind = 'school' → admin_id NOT NULL   -- 이 코드로 가입한 학생은 이 관리자의 담당이 된다
kind = 'admin'  → admin_id NULL       -- 관리자 승격용. 담당 개념 없음
CHECK 로 두 조합만 허용한다.
```

| 정책 | 내용 |
|---|---|
| select | **`kind='school' and admin_id = auth.uid()`** — 관리자가 자기 코드 1행만 읽는다 |
| insert / update / delete | **0개.** 시딩·SQL 전용(결정 C) |

- **학생에게 select 를 열지 않는다.** 코드 유효성 검사는 정의자 함수 안에서 일어나므로 읽기 권한이 필요 없다. 열면 전체 코드 목록이 열거된다.
- 코드 정규화는 `invite_normalize()`(trim + upper) 한 곳이 소유한다 — `qr_normalize_token()` 전례 그대로. 저장도 정규화된 형태로만 한다.
- **`used_by` / 1회용 개념을 두지 않는다.** 관리자별 고정 코드(결정 C)라 여러 학생이 같은 코드로 가입하는 것이 정상 도메인이다.

---

## 결정 4 — 사전 검증 RPC 를 따로 둔다 (`check_signup_availability`)

트리거 예외는 PostgREST 를 거쳐 `Database error saving new user` 같은 문구로 올라온다. 사용자에게 그대로 보여줄 수 없다.

- `check_signup_availability(p_role, p_code, p_invite)` → `{ok, reason}` (anon 실행 가능, `security definer`)
- 프런트는 **가입 버튼을 누른 직후 이것을 먼저 호출**해 중복 학번·잘못된 초대코드를 친절한 문구로 막고, 통과했을 때만 `signUp()` 한다.
- **이것은 UX 계층이지 보안 경계가 아니다.** 우회하면 트리거와 `code unique` 제약이 최종 판정한다(같은 값을 두 곳에서 검사하는 것이 의도된 구조다).
- **학번 존재 여부가 anon 에게 노출되는 것을 수용한다.** 학번은 교실에서 공개적으로 쓰이는 식별자이고, 비밀번호 없이는 아무것도 되지 않는다. 가입 UX 를 위해 필요한 최소 노출이다.

---

## 결정 5 — `account_type` 은 `profiles` 컬럼이고, 쓰는 경로는 2개뿐

`mentor_students` 로는 학생이 자기 소속을 알 수 없다 — 그 테이블 정책에 **학생 축이 없다**(ADR 0005: "학생은 자기 멘토가 누구인지도 모른다"). 그 경계를 열지 않기 위해 `profiles.account_type`(`school`/`personal`, 관리자는 NULL)을 둔다.

**ADR 0007 결정 3-6 표 개정** — 아래 한 행이 추가된다. 나머지 행은 그대로다.

| `profiles` 컬럼 | 값을 넣는 경로 | update 정책 |
|---|---|---|
| `account_type` | `handle_new_user()` 트리거(가입 시) / `link_school_account()`(개인→학교, 유일) | **0개** |

- `link_school_account(p_invite)` 의 UPDATE SET 목록은 **`account_type` 하나뿐**이다. 그것이 컬럼 경계의 전부다(결정 3-6 규율 그대로).
- 같은 함수가 `mentor_students` 1행을 insert 한다. **이것이 앱에서 매핑을 만드는 유일한 경로**이며, 주체는 **학생 본인의 코드 입력**이다. 관리자가 임의 학생을 지목하는 경로는 여전히 0개다.
- **소속 해제(school → personal)를 만들지 않는다.** `mentor_students` delete 경로가 필요해지고, 그건 학생이 자기 기록을 관리자 시야에서 지울 수 있게 만드는 일이다.

---

## RLS/권한 영향

### 이번에 열리는 것
| 대상 | 무엇 | 경계 |
|---|---|---|
| anon | `check_signup_availability()` 실행 | 반환값이 `{ok, reason}` 뿐. 이름·id·다른 계정 정보를 돌려주지 않는다 |
| authenticated(관리자) | `invite_codes` select | 본인 school 코드 1행 |
| authenticated(학생) | `link_school_account()` 실행 | 본인 행의 `account_type` + 본인 매핑 1행 |
| (트리거) | `profiles` insert, `mentor_students` insert | 정의자 권한. 클라이언트에서 직접 호출할 수 없다 |

### 닫힌 채로 유지되는 것 (확인 완료)
- `profiles` insert/update/delete 정책 **0개** — 트리거·definer 함수 밖에서 프로필을 만들거나 고칠 수 없다
- `mentor_students` insert/update/delete 정책 **0개** — 관리자에게는 여전히 매핑 편집 경로가 없다
- `invite_codes` insert/update/delete 정책 **0개** — 앱에서 코드를 만들 수 없다
- `points_*` / `currency_balance` 는 이 ADR 의 어떤 함수도 SET 목록에 넣지 않는다 — **가입 보너스가 없다**(원칙 1)
- `verify_participation_qr()` / `issue_participation_qr()` / 정원 트리거 **수정 0줄**

### 공격 경로 대조표
| 시도 | 결과 |
|---|---|
| 가입 metadata 에 `role: 'admin'` | 관리자 초대코드가 없으면 **22023 → 가입 롤백** |
| 관리자 초대코드를 앱에서 만들기 | insert 정책 0개 → 403 |
| 남의 학교 코드로 남을 담당에 넣기 | 함수가 `student_id`를 인자로 받지 않는다(본인 = `auth.uid()`) |
| `profiles.account_type`을 직접 update | update 정책 0개 → 0행 |
| `mentor_students` 직접 insert | 정책 0개 → 403 |
| 이미 있는 학번으로 가입 | `profiles.code` unique → 23505 → 롤백 |
| 초대코드 목록 열거 | select 정책이 본인 school 코드뿐 → 0행 |

---

## 대안으로 고려했던 것
- **`profiles`에 `pending` 상태를 두고 관리자가 승인** — 관리자 4번째 기능이 되고(원칙 6) 상태 기계가 하나 더 는다. 데모에서 얻는 값이 없다.
- **초대코드를 1회용 토큰으로** — 결정 C(관리자별 고정)와 충돌한다. 여러 학생이 같은 코드를 쓰는 것이 정상 도메인이다.
- **학교(schools) 엔티티 도입** — 관리자 1명이 곧 학교 단위인 데모 규모에서는 테이블만 늘어난다. CLAUDE.md 11장(학교 단위 대시보드 제외)과도 방향이 어긋난다.

## 구현 가이드
- 마이그레이션: `supabase/migrations/20260731120000_add_signup_invite_codes_and_account_types.sql`
- **기존 관리자에게 school 코드를 결정론적으로 백필한다**(`SCH-` + md5(id) 앞 4자리) — 재실행해도 같은 값이라 안전하다.
- 프런트: `authService.signUpStudent/signUpAdmin` + `SignupPage` + 양쪽 마이페이지 1블록. **로그인 함수 3개는 수정하지 않는다.**
- **Supabase 대시보드에서 "Confirm email" 을 꺼야 한다** — 코드로 할 수 없고, 켜져 있으면 가입 후 세션이 생기지 않는다.

## qa-agent 가 볼 것
1. **가입 폼을 우회해 관리자가 될 수 있는가** — metadata 조작, RPC 직접 호출, `profiles` 직접 insert 전부.
2. **시드 계정 6개와 시드 스크립트가 그대로 동작하는가**(트리거가 시딩 경로를 건드리지 않았는가).
3. **연동 후 `account_type` 외의 컬럼이 바뀌지 않았는가** — `points_*`/`role`/`code`를 DB 에서 직접 확인.
