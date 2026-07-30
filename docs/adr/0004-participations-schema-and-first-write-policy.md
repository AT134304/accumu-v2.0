# ADR 0004: participations 스키마 및 앱 최초의 쓰기(insert) 권한 경계 확정

## 상태
확정 (일부 항목 "케빈 확인 필요" 표시 — 블로킹 아님)

## 배경
`docs/specs/student-programs.md`에서 프로그램 선택 화면 + 참여 신청 팝업이 확정됐고, "확정된 결정 A-1~H-1"(2026-07-16, 케빈 승인)이 이미 정해져 있다. 이 ADR은 그 결정을 전제로, 실제 SQL로 확정되지 않은 부분만 다룬다.

`participations`는 CLAUDE.md 5장에 필드 목록(`id, student_id, program_id, status, entry_at, exit_at, entry_token, exit_token`)만 있고 SQL로 구체화된 적이 없다. 이번 기능에서 처음 생성한다.

**핵심 쟁점은 스펙 "이슈 1 — 권한 표면"이다.** 지금까지 이 앱의 RLS 정책은 select 2개(`profiles_select_own`, `programs_select_published`)가 전부였고 insert/update/delete 정책은 **전 테이블 0개**였다. 즉 앱은 읽기 전용이었다. 이번에 학생이 DB에 쓰는 첫 경로가 열린다.

지금 이 정책이 느슨하면 무해해 보인다 — 포인트 지급 로직이 아직 없기 때문이다. 그러나 **다음 스펙(QR 이중 인증)에서 포인트 지급이 붙는 순간, 느슨한 insert 정책은 그대로 부정 적립 경로가 된다.** QR 2회 인증은 부정 참여 방지 장치인데(CLAUDE.md 2장 5번) 그 옆에 뒷문을 열어두는 셈이다. 이 ADR은 그 문을 **지금** 닫는다.

## 결정 (스키마 변경 포함)
전체 SQL은 `docs/db/schema.sql`. 요약:

### 1. `participation_status` enum (3종) — `program_status`와 이름·개념 모두 다르다

```
create type participation_status as enum ('applied', 'entered', 'completed');
```

| enum 값 | 의미 | 이번 스코프에서 생성되나 |
|---|---|---|
| `applied` | 신청함 (participations 행 생성 시점) | **O — 유일하게 생성되는 값** |
| `entered` | 입장 인증 완료 (`entry_at` 기록됨) | X (QR 스펙) |
| `completed` | 퇴장 인증 완료 = 참여 완료 → 포인트 지급 대상 | X (QR 스펙) |

**타입명 주의 — `programs.status`(`program_status`)와 혼동 금지.** 두 컬럼 다 이름이 `status`지만 개념이 완전히 다르다:

| | `programs.status` | `participations.status` |
|---|---|---|
| 타입 | `program_status` (open/ing/wait/full/over) | `participation_status` (applied/entered/completed) |
| 주체 | 프로그램의 모집 상태 | 한 학생의 참여 진행도 |
| 소유 | 정적 필드. 신청 가능 여부(`join`) 매핑은 **프런트 `STATUS` 맵**이 소유 (ADR 0003 4번) | 상태 전이는 **DB/서버**가 소유 (QR 토큰 검증 결과로만 바뀐다) |

**값 3종을 지금 정의하는 근거 (지어낸 값이 아니다).** CLAUDE.md 6장이 QR 흐름을 이미 확정했고, 상태 지점이 기계적으로 도출된다: (1) 신청 → (2) 입장 인증 시 `entry_at` 기록 → (3) 퇴장 인증 시 `exit_at` 기록 + 포인트 지급. `entry_at`/`exit_at` 컬럼을 이번에 만드는 결정(아래 3번)과 정확히 짝을 이룬다 — `entry_at` 컬럼이 도메인에 존재한다는 것은 곧 `entered` 상태가 도메인에 존재한다는 뜻이다.

**`applied` 1종만 만들지 않은 이유** (검토했고 기각):
- 값이 1종뿐이면 아래 RLS의 `status = 'applied'` 술어가 **자명해 보여 삭제 유혹이 생긴다.** 그 술어는 이 ADR에서 가장 중요한 방어선 중 하나다. 값이 3종이면 그 술어가 실제로 무언가를 막고 있다는 사실이 SQL에 드러난다.
- `alter type ... add value`는 PG12+에서 가능하지만 "추가한 값을 같은 트랜잭션에서 쓸 수 없다"는 제약이 있어(ADR 0003 1번에 이미 기록됨) QR 스펙에서 마이그레이션을 쪼개야 한다.

**넣지 않은 값**: `cancelled`(확정 G-1이 신청 취소를 스코프 밖으로 뺐고 CLAUDE.md 6장에도 없다), `no_show`(어디에도 근거 없음 — 추측). 필요해지면 QR/취소 스펙에서 `alter type add value`로 추가한다.

### 2. participations 테이블 — 컬럼 확정

| 컬럼 | 타입 | 제약 | 근거 |
|---|---|---|---|
| `id` | uuid | PK, `default gen_random_uuid()` | `mentor_students`/`programs` 전례 |
| `student_id` | uuid | not null, `references profiles(id) on delete cascade` | CLAUDE.md 5장 |
| `program_id` | uuid | not null, `references programs(id) on delete cascade` | 〃 |
| `status` | `participation_status` | not null, **default `'applied'`** | 〃 |
| `entry_at` | timestamptz | nullable | 〃 (아래 3번) |
| `exit_at` | timestamptz | nullable | 〃 (아래 3번) |
| `entry_token` | **text** | nullable | 〃 (아래 3번) |
| `exit_token` | **text** | nullable | 〃 (아래 3번) |
| `created_at` | timestamptz | not null, default now() | 아래 "주의 2" |
| — | — | **`unique (student_id, program_id)`** | 아래 4번 |

**주의 1 — 토큰 컬럼은 `text`다.** ADR 0003은 값 집합이 닫힌 것(`career_track` 등)을 enum으로 좁혔지만, 여기는 반대 상황이다. **토큰의 형식은 QR 스펙의 결정사항이고 지금 미정이다** — 랜덤 문자열/base64/uuid 중 무엇이 될지 알 수 없다. `uuid`로 좁히면 QR 스펙이 다른 형식을 택할 때 타입 변경 alter가 필요하다. 값 집합이 확정됐을 때 타입으로 좁히는 것과, 미정일 때 타입으로 좁히는 것은 다르다 — 후자는 추측이다.
- **`unique` 제약을 붙이지 않는다.** 토큰 재사용 방지에 unique가 관여할 수 있지만, 재사용 방지 메커니즘 자체가 QR 스펙의 설계다(만료 시각을 DB 컬럼에 둘지 토큰 payload에 둘지도 미정). 근거 없이 제약을 미리 박지 않는다.

**주의 2 — `created_at`은 임의 추가가 아니다.** CLAUDE.md 5장 participations 필드 목록에는 없지만, (a) ADR 0002가 `profiles`/`mentor_students`에, ADR 0003이 `programs`에 동일하게 `created_at timestamptz not null default now()`를 추가한 전례가 3건 있고, (b) "언제 신청했는지"는 참여 이력의 기본 축이라 이후 아카이브/마이페이지에서 필요해지며, (c) uuid PK는 생성 순서를 담지 못한다. ADR 0003 "주의 2"와 동일한 근거.

**주의 3 — FK는 양쪽 다 `on delete cascade`.** `programs.created_by`가 `on delete set null`(기록 보존)인 것과 다르다:
- `student_id`: 학생 계정이 사라지면 그 학생의 신청도 의미가 없다. `mentor_students` 양쪽 FK 전례와 동일.
- `program_id`: **앱에 프로그램 삭제 UI가 없다** — 관리자 기능 3종은 올리기/내리기/수정이고, "내리기"는 `is_published = false` 토글이지 삭제가 아니다(CLAUDE.md 2장 6번, 10장). 즉 삭제는 시연 리셋 때 service_role로 하는 경우뿐인데, `restrict`면 참여 행 때문에 그 리셋이 막혀 오히려 불편하다.

**주의 4 — `student_id`에 `default auth.uid()`를 두지 않는다.** Supabase에서 흔한 패턴이지만 여기서는 기각한다: **클라이언트가 값을 보내면 default는 그냥 무시되므로 default는 방어가 아니다.** 방어는 오로지 아래 RLS `with check (student_id = auth.uid())`가 한다. 방어처럼 생겼지만 방어가 아닌 장치를 두면, 나중에 읽는 사람이 "default가 있으니 안전하다"고 오해할 여지가 생긴다. 클라이언트가 `student_id`를 명시적으로 보내고 정책이 검증하는 구조가 경계를 더 정직하게 드러낸다.

**주의 5 — 인덱스를 추가로 만들지 않는다.** ADR 0003 "주의 4"와 동일(데모 20행 규모). 단 `unique (student_id, program_id)`가 만드는 인덱스는 제약의 부산물이라 예외다 — 스펙도 이 예외를 명시했다. 이 인덱스는 선두 컬럼이 `student_id`라 `participations_select_own`의 `student_id = auth.uid()` 조회도 그대로 커버한다. **`program_id` 단독 인덱스를 추가하지 말 것.**

### 3. `entry_at` / `exit_at` / `entry_token` / `exit_token`을 **이번에 만든다** (핵심 판단)

QR은 다음 스펙인데도 지금 만든다. 근거 3가지:

1. **CLAUDE.md 5장이 이미 확정한 필드다.** 임의 추가가 아니고, PM 스펙도 이 목록을 그대로 인용했다.
2. **전례.** ADR 0002는 `points_balance`/`points_total`/`currency_balance`/`career_interest`를 로그인 기능에서 전혀 쓰지 않으면서도 "profiles가 처음 생성되는 시점이라 함께 정의해 이후 기능에서 재마이그레이션이 필요 없게 한다"며 넣었다. ADR 0003은 `popularity`를 "지금 저장만, 사용은 다음 화면"으로 처리했다.
3. **(결정적) 컬럼이 있어야 지금 봉인할 수 있다.** RLS `with check`는 **행 단위 술어**다. 존재하지 않는 컬럼은 미리 금지할 수 없다. 만약 이 컬럼들을 QR 스펙에서 추가한다면, 그 시점의 `participations_insert_own` 정책은 새 컬럼을 언급하지 않으므로 **학생이 `entry_at`을 채우거나 토큰을 심어 insert하는 경로가 조용히 열린다.** 컬럼 추가와 정책 개정을 backend-agent가 반드시 함께 해야만 막히는데, 그건 문서 규율에만 기대는 방어다. 지금 컬럼을 만들고 `entry_at is null and exit_at is null and entry_token is null and exit_token is null`을 정책에 박아두면 **그 구멍이 애초에 생기지 않는다.**

즉 이 4개 컬럼은 "이번 스코프에서 안 쓰는 컬럼"이 아니라 **스펙 이슈 1의 보안 요구사항을 성립시키는 전제**다. 스펙이 "막아야 할 것"에 `entry_at`/`exit_at`/토큰을 명시했는데, 컬럼을 안 만들면 그 요구사항 자체를 SQL로 표현할 방법이 없다.

**정직한 반론과 답**: "토큰 만료/사용 시각 컬럼(예: `entry_token_expires_at`)은 어차피 QR 스펙에서 추가될 텐데, 그럼 alter를 없앤다는 이득은 반쪽 아닌가?"
- 맞다. **만료·사용 시각 컬럼은 이번에 만들지 않는다** — CLAUDE.md 5장에 없고, 만료를 DB 컬럼에 둘지 QR payload에 둘지는 QR 스펙의 설계 결정이라 지금 정하면 추측이 된다.
- 이번 결정의 이득은 "**alter가 0이 된다**"가 아니라 "**지금 봉인 가능한 것을 지금 봉인한다**"이다.
- 그리고 이 결정이 미래의 컬럼 추가 리스크까지 상당 부분 무력화한다: QR 스펙이 `entry_token_expires_at`을 추가하고 정책 개정을 잊더라도, **학생은 여전히 `entry_token`을 심을 수 없다**(이번 정책이 막고 있음). 만료 시각만 위조할 수 있는 토큰은 존재하지 않는 토큰이므로 쓸모가 없다. 즉 **토큰 컬럼을 지금 봉인하는 것이 그 주변 컬럼들의 방어까지 함께 세운다.**

### 4. 중복 신청 차단 — `unique (student_id, program_id)`

인수 조건이 "**DB 제약으로도 막힌다** (개발자도구로 클라이언트 방어를 우회해도 거부)"를 명시했다. 클라이언트 방어(버튼 비활성)만으로는 새로고침·두 탭 동시 클릭·개발자도구에서 뚫린다.

- 위반 시: Postgres `23505 unique_violation` → PostgREST **HTTP 409**.
- 상태 무관하게 (student, program) 쌍당 1행이다. 즉 "취소 후 재신청"은 구조적으로 불가능한데, 확정 G-1이 신청 취소를 스코프 밖으로 뺐으므로 이번엔 문제되지 않는다. 취소가 생기면 그때 "행 삭제 후 재신청" vs "`cancelled` 상태 + unique 완화"를 재결정한다(아래 "향후 변경").

### 5. 신청 여부 조회 / 홈 추천 제외(D-1) — 클라이언트 필터 (뷰·embed 기각)

**ADR 0003 6번의 판단을 그대로 유지한다.** `programs`와 `participations`를 조인하는 뷰를 만들지 않는다.

```
// 병렬 2쿼리
[A] select {필드} from programs where is_published = true            -- RLS와 중복이지만 의도 명시
[B] select id, program_id, status from participations                -- RLS가 본인 행만 내려준다
// -> 클라이언트에서 Set(B.program_id)에 없는 A만 남긴다
```

- **뷰 기각**: ADR 0003 6번이 지적한 그대로 — Postgres 뷰는 기본이 정의자(owner) 권한이라(`security_invoker`를 켜지 않는 한) `participations_select_own` 경계를 우회한다. 여기서는 함정이 더 나쁘다: **다른 학생의 신청 내역이 새는 뷰**가 만들어진다.
- **PostgREST embed(`programs?select=*,participations(id)`) 기각**: embed는 각 테이블 RLS가 적용되므로 뷰만큼 위험하진 않지만, 권한 경계가 쿼리 문자열 구조에 녹아들어 "이게 왜 안전한가"를 매번 재확인해야 한다. 20행 규모에 그 인지 비용을 살 이유가 없다.
- **`.not('id','in','(...)')` 기각**: 어차피 `participations`를 먼저 조회해야 해서 왕복 수가 같고, 목록이 커지면 URL 길이 문제가 생긴다.
- **제외 기준은 `program_id` 존재 여부이며 `status`를 보지 않는다.** 지금은 `applied`뿐이라 같은 결과지만, QR 스펙에서 `entered`/`completed`가 생겨도 그것들 역시 추천에서 빠져야 맞다(프로토타입 `recommended()`의 `!isJoined && !isCompleted`와 동일한 의미). status를 조건에 넣으면 그때 조용히 되살아난다.
- **필터는 `slice(0, 8)` 앞에서 수행한다.** 뒤에서 하면 신청한 만큼 홈 카드가 8장 미만으로 줄어든다.

## RLS/권한 영향

### 이번에 추가하는 정책: 2개 (select 1 + insert 1)

```
[RLS 권한 경계] participations_select_own
  대상 역할: authenticated
  허용 행: student_id = auth.uid() 인 행만 select
  불가능: 다른 학생의 신청 내역 조회 (학생↔학생, 관리자↔학생 전부 차단 — 관리자 정책 없음)

[RLS 권한 경계] participations_insert_own
  대상 역할: authenticated
  허용 행: 아래 with check 6절을 전부 만족하는 행만 insert
  불가능: 남의 이름으로 신청 / 완료 상태 위조 / 입퇴장·토큰 선주입 / 미게시 프로그램 신청
```

**insert의 `with check` 전문 (이 ADR의 핵심 산출물):**

```sql
with check (
  student_id = auth.uid()
  and status = 'applied'
  and entry_at is null
  and exit_at is null
  and entry_token is null
  and exit_token is null
  and exists (
    select 1
    from public.programs p
    where p.id = participations.program_id
      and p.is_published = true
  )
)
```

### 각 절이 막는 것 (스펙 이슈 1 대조표)

| 공격 경로 | 차단 장치 | 공격자가 실제로 보게 되는 것 |
|---|---|---|
| **남의 이름으로 신청** (`student_id` 위조) | `student_id = auth.uid()` | `42501` / HTTP 403 |
| **스스로 "참여 완료" 상태로 insert** (→ QR 스펙에서 부정 적립) | `status = 'applied'` | `42501` / 403 |
| **`entry_at`/`exit_at` 직접 기록** (QR 입·퇴장 인증 우회) | `entry_at is null and exit_at is null` | `42501` / 403 |
| **토큰 선주입** (자기가 아는 토큰을 심어두고 QR 생성) | `entry_token is null and exit_token is null` | `42501` / 403 |
| **중복 신청** (새로고침·두 탭·개발자도구) | `unique (student_id, program_id)` 제약 | `23505` / **409** |
| **미게시 프로그램에 신청** (uuid를 알아냈다고 가정) | `exists (... is_published = true)` | `42501` / 403 |
| **다른 학생의 신청 내역 조회** | `participations_select_own`의 `using` | 0행 (에러 아님) |
| **신청 수정·삭제** (상태를 completed로 바꾸기 등) | update/delete 정책 **0개** | 0행 영향 (RLS가 행을 안 보여줌) |
| **비로그인(anon) 접근** | `to authenticated` + `auth.uid()`가 NULL | 403 / 0행 |

### 설계 근거 (절별)

**`status = 'applied'` — 이 앱에서 포인트로 가는 유일한 문의 자물쇠.**
아직 포인트 지급 로직이 없으므로 이 절은 지금 아무것도 하지 않는 것처럼 보인다. 그 인상이 정확히 위험 지점이다. QR 퇴장 인증이 포인트를 지급하는 순간(CLAUDE.md 6장 3번), 이 절이 없으면 학생은 `status: 'completed'` 한 줄로 QR 이중 인증을 통째로 건너뛴다. **CLAUDE.md 2장 5번("QR은 부정 참여 방지 장치이므로 단순화하지 않음")을 데이터 설계 단계에서 지키는 것이 이 절이다.**
- `default 'applied'`가 있으므로 프런트는 이 컬럼을 아예 보내지 않으면 된다. 정책은 프런트가 보내든 안 보내든 최종 행 값을 검사한다.

**`exists (... is_published = true)` — 서브쿼리를 `with check`에 쓸 수 있는가? → 가능하다.**
RLS 정책 표현식은 일반 SQL 표현식이라 서브쿼리를 포함할 수 있다. 두 가지 주의를 검토했다:
1. **참조되는 `programs`의 RLS가 이 서브쿼리 안에서도 적용된다** (정책 표현식은 질의자의 권한으로 평가된다 — Supabase가 이 경우 `security definer` 함수를 권하는 이유가 바로 이것이다). 즉 `programs_select_published`(`to authenticated`, `using (is_published = true)`)가 자동으로 걸린다.
2. 그럼에도 **`and p.is_published = true`를 명시적으로 쓴다.** 중복처럼 보이지만 의도적이다 — 관리자 프로그램 관리 스펙이 오면 "admin은 미게시 행도 select 가능" 정책이 `programs`에 추가될 예정인데(ADR 0003 "RLS 영향"에 예고됨), 그러면 서브쿼리가 admin에게 미게시 행을 보여주게 되어 **`participations`의 경계가 `programs` 정책 변경에 딸려 조용히 흔들린다.** 명시하면 이 정책은 다른 테이블 정책의 진화와 무관하게 자기 경계를 스스로 지킨다. `programService`가 `is_published` 조건을 RLS와 중복해서 거는 "이중 안전장치" 관례(ADR 0003 6번)와 같은 손놀림이다.
- **무한 재귀 없음**: `programs` 정책은 `participations`를 참조하지 않는다.
- **정보 유출 없음**: 존재하지 않는/미게시 uuid로 insert하면 거부되므로 이론상 uuid 존재 여부를 탐지할 수 있으나, uuid는 불투명 식별자라 실질 리스크가 없다(스펙도 같은 판단).

**`to authenticated`를 두 정책 모두에 명시한다.**
`student_id = auth.uid()`는 anon에서 `auth.uid()`가 NULL이라 자연히 거짓이 되므로 `to` 절 없이도 안전하다(`profiles_select_own`과 같은 구조). 그럼에도 명시하는 이유: **이 테이블은 앱 최초의 쓰기 경로라 정책의 대상 역할을 독자의 추론에 맡기지 않는다.** 특히 insert 정책에서 `to`를 생략하면 대상이 `public` 역할이 되고, anon 차단이 술어 하나에만 걸리게 된다. `programs_select_published`가 세운 관례(ADR 0003)를 따른다.

### 이번에 **넣지 않는** 정책 — update / delete / 관리자

- **update/delete 정책 0개 = 전체 거부.** 확정 G-1(신청 취소 스코프 아님). `mentor_students`에 정책을 0개 둔 ADR 0002의 원칙과 동일 — 필요할 때 연다. 시연 리셋은 `delete from public.participations;`(service_role, RLS 우회).
- **관리자 정책은 이번에 넣지 않는다.** ADR 0003이 `programs` admin 정책을 미룬 것과 **같은 근거 + 하나 더**:
  - QR 스캔 시 관리자는 남의 `participations` 행을 update해야 하는데, 그 정책의 **행 경계**(담당 학생만? 전체?)와 **컬럼 경계**(entry_at/status만?)는 QR 토큰 검증 설계와 한 몸이다. 지금 정하면 근거 없는 추측이 되고, 안 쓰는 쓰기 권한이 열린 채 남는다.
  - **추가 근거(중요) — RLS는 컬럼 단위가 아니다.** `for update ... using (관리자 조건)` 같은 정책을 순진하게 열면 **관리자가 그 행의 모든 컬럼을 바꿀 수 있다**(`student_id`를 다른 학생으로 옮기는 것 포함). 즉 QR 스캔은 정책보다 **`security definer` RPC(토큰을 인자로 받아 검증 후 서버가 컬럼을 확정)** 가 유력하다. 이건 QR 스펙의 별도 ADR에서 결정할 사안이지, 지금 정책을 미리 열어 결정을 선점할 일이 아니다.
  - 담당 학생 아카이브용 admin select 정책도 `mentor_students` 정책과 한 세트라 아카이브 스펙 몫이다(ADR 0002가 이미 예고).

### 알려진 틈 (수용, 문서화)

- **`created_at`은 위조 가능하다.** 프런트가 `created_at`을 보내면 `with check`가 검사하지 않으므로 통과한다. 수용 근거: (a) 위조 대상이 **본인 행의 신청 시각**뿐이고, (b) 어떤 권한·포인트 결정에도 쓰이지 않으며, (c) 이를 막는 술어(`created_at = now()` — 트랜잭션 내 `now()` 안정성에 기대는 비자명한 비교)는 프런트가 값을 보내는 순간 원인 불명의 RLS 에러를 내서 **방어 이득 없이 디버깅 비용만 만든다.** 대신 구현 가이드에 "insert에 `student_id`/`program_id` 외 어떤 컬럼도 보내지 않는다"를 명시한다. `created_at`이 포인트/권한 판단에 쓰이게 되면 그때 재검토(아래 "향후 변경").
- **`id`(PK uuid)를 클라이언트가 지정할 수 있다.** 본인 행의 PK를 스스로 고르는 것뿐이고 unique가 보장되므로 무해. ADR 0002가 "이름 검증 후 signOut" 절충을 accepted risk로 문서화한 것과 같은 처리.
- **지난 날짜(`date < 오늘`) 프로그램 신청은 DB가 막지 않는다** — 다음 항목 참고.

### `date < 오늘`(H-1)과 `status`(full/over/ing) 차단을 `with check`에 넣지 않는 이유

경계선을 이렇게 긋는다: **권한 경계는 DB, 신청 가능 여부(UX 규칙)는 프런트.**

1. **`is_published`는 권한 경계다.** 미게시 = 관리자가 아직 공개하지 않은 데이터 = 학생에게 존재하지 않아야 하는 것. DB가 이미 select로 소유한 경계이므로 insert에도 같은 경계를 적용하는 게 일관적이다. → **막는다.**
2. **`status`(full/over/ing)는 권한 경계가 아니다.** ADR 0003 4번이 "신청 가능 여부(`join`) 매핑은 DB가 아니라 프런트 `STATUS` 맵이 소유한다"를 확정했다. DB에 `status in ('open','wait')`를 박으면 같은 규칙이 두 레이어로 쪼개져 드리프트한다(프런트 맵에서 `wait.join`을 false로 바꾸면 DB와 어긋난다). → **막지 않는다.**
3. **`date >= 오늘`(H-1)도 권한 경계가 아니다.** 지난 프로그램에 신청해도 부정 적립이 되지 않는다 — 포인트는 QR 퇴장 인증에서만 지급되고, 지난 프로그램에는 QR을 스캔할 관리자가 없다. 게다가 **타임존 함정이 있다**: 정책 안의 `current_date`는 세션 TimeZone(Supabase 기본 UTC) 기준이라 KST와 어긋나고(KST 00:00~09:00 구간에 어제 날짜가 통과한다), 이를 피하려면 `(now() at time zone 'Asia/Seoul')::date`를 정책에 박아야 하는데 그러면 ADR 0003이 "`todayISO`는 프런트 로컬 기준"으로 확정한 날짜 소스가 두 곳으로 갈린다. → **막지 않는다.**
4. 인수 조건도 이 선과 일치한다 — "DB 제약으로도 막힌다"를 요구한 건 **중복 신청 1건뿐**이고, H-1/status는 화면 동작으로만 요구한다.

### 이번 변경이 만드는 노출 경로 재검토 (결론: 없음)

- **다른 학생의 신청 내역**: `participations_select_own` 하나뿐이라 차단. 관리자 정책도 없으므로 관리자조차 볼 수 없다(= 담당 학생 아카이브는 아직 미구현이 맞다).
- **`participations`를 통한 `profiles` 유출 없음**: `student_id`(uuid)만 저장되고, `profiles`는 여전히 `profiles_select_own` 하나뿐이라 uuid를 이름/학번으로 조인할 경로가 없다. ADR 0003이 `programs.created_by`에 대해 내린 판단과 동일.
- **신청자 수 집계 경로 없음**: 학생은 본인 행만 보이므로 `count(*)`를 던져도 자기 신청 수만 나온다. 스펙의 절대 원칙 가드("N명이 신청했어요 표시 금지", "학생 단위 집계·랭킹 금지")가 **UI 규율이 아니라 RLS 구조로도 성립한다.**
- **포인트 경로 없음**: `point_transactions` 테이블 자체가 없고, `profiles`에 update 정책이 0개라 학생이 `points_balance`를 건드릴 방법이 없다. **신청만으로 포인트가 지급되지 않는다**(CLAUDE.md 2장 3번, 인수 조건 시각 점검 항목)가 트리거 없이 구조적으로 보장된다. **포인트 지급 트리거를 이번에 만들지 않는다** — 지급 시점은 QR 퇴장 인증이다.

## 대안으로 고려했던 것

- **컬럼 단위 insert 권한**(`revoke insert on participations from authenticated; grant insert (student_id, program_id) on participations to authenticated;`): 학생이 지정 가능한 컬럼을 2개로 못박아 `created_at`과 **미래에 추가될 모든 컬럼까지 자동으로 거부(fail-closed)** 하는, 이론적으로 가장 강한 방법이다. 그럼에도 기각:
  - **스펙 이슈 1이 명시한 5개 공격 경로가 RLS `with check`만으로 전부 봉인된다.** 컬럼 grant의 추가 이득은 `created_at`(무해 — 위 "알려진 틈")과 미래 컬럼뿐인데, 미래 컬럼 리스크는 위 3번에서 설명했듯 **토큰 컬럼을 지금 봉인함으로써 이미 대부분 무력화됐다**(토큰을 못 심으면 만료 컬럼 위조는 무의미).
  - 기존 마이그레이션 3개가 Supabase 기본 grant 상태를 한 번도 건드리지 않았다. 여기서 처음 손대면 이 테이블만 권한 모델이 이중(grant + RLS)이 되어, "왜 거부됐는가"를 추적할 곳이 두 군데가 된다.
  - 스키마 변경이 반드시 ADR을 거치는 절차가 확립돼 있고(0002→0003→0004), QR 스펙 ADR이 정책 재검토를 강제한다. 아래 "향후 변경"에 재검토 항목으로 남긴다 — **컬럼이 더 늘고 update 정책까지 열리는 QR 스펙 시점이 이 방법의 원래 자리다.**
- **`before insert` 트리거로 값 강제**(status:='applied', entry_at:=null …): fail-closed지만 **조용히 덮어쓴다** — 공격 시도가 성공으로 보인다. RLS 거부(403)가 시끄러워서 더 낫다. 미래 컬럼도 못 막는다. 기각.
- **`entry_at`/토큰 컬럼을 이번에 만들지 않기**: "안 쓰는 컬럼을 만들지 않는다"는 깔끔함은 있으나, **스펙 이슈 1이 요구한 봉인을 SQL로 표현할 수 없게 된다**(위 3번). 기각.
- **`participation_status`를 `applied` 1종만**: `status = 'applied'` 술어가 자명해 보여 삭제되기 쉽고, QR 스펙에서 `alter type add value`의 트랜잭션 제약을 떠안는다. 기각(위 1번).
- **`status`를 저장하지 않고 `entry_at`/`exit_at`에서 파생**: CLAUDE.md 5장이 `status`를 필드로 정의했고, 파생이면 "완료 상태 위조 차단"을 `entry_at`/`exit_at` NULL 강제로만 표현하게 되어 방어 의도가 SQL에서 덜 드러난다. 기각.
- **`programs` 조인 뷰 / PostgREST embed로 "신청 여부"를 한 번에 조회**: ADR 0003 6번의 정의자 권한 함정 + 권한 경계를 쿼리 구조에 섞는 비용. 기각(위 5번).
- **`student_id uuid default auth.uid()`**: 방어가 아닌데 방어처럼 보인다. 기각(위 "주의 4").
- **`with check`에 `date >= 오늘` / `status in ('open','wait')` 추가**: 권한 경계가 아닌 UX 규칙이고, 프런트 `STATUS` 맵과 이중화되며, 타임존 소스가 갈린다. 기각(위 "넣지 않는 이유").
- **admin RLS 정책 선반영**: ADR 0003과 동일 근거 + RLS가 컬럼 단위가 아니라는 추가 근거. 기각.
- **`unique (student_id, program_id)` 대신 partial unique**(`where status <> 'cancelled'`): `cancelled` 값 자체가 없어 무의미. 기각.

## 향후 변경 (이번 스코프 아님, 예정만 기록)

- **QR 이중 인증 (다음 스펙) — 이 ADR에서 가장 무거운 후속 항목.** 그 ADR이 반드시 함께 결정할 것:
  - 토큰 발급/검증 경로: **정책 vs `security definer` RPC** (위 "관리자 정책을 넣지 않는 이유" 참고 — RLS는 컬럼 단위가 아니라 순진한 update 정책은 `student_id`까지 열어준다).
  - 만료(발급+30분)·1회용 검증을 **DB 컬럼**에 둘지 **토큰 payload**에 둘지. 컬럼이면 `entry_token_expires_at`/`*_used_at` 등이 추가된다.
  - **컬럼이 추가되면 `participations_insert_own`의 `with check`를 반드시 함께 재검토할 것.** 정책은 행 단위 술어라 새 컬럼을 자동으로 막지 않는다. 이 시점이 위에서 기각한 **컬럼 단위 insert grant를 재검토할 자리**다.
  - `status` 전이(`applied → entered → completed`)를 누가 쓰는지, 그리고 포인트 지급(`point_transactions` + `profiles.points_*` update)을 어떤 권한으로 수행할지.
  - admin의 `participations` update 정책 행 경계(담당 학생만 vs 전체 — `mentor_students`와 연동).
- **`created_at` 위조 재검토**: 이 값이 포인트/권한/정렬 이외의 판단에 쓰이게 되면 봉인 방법을 다시 본다(현재는 수용된 틈).
- **신청 취소**: 확정 G-1이 뺐다. 생기면 delete 정책(본인 행 + `status = 'applied'`인 것만) vs `cancelled` 상태 + unique 완화를 결정한다. QR 토큰/포인트와 얽히므로 QR 스펙 이후가 자연스럽다.
- **`programs.status` 파생 전환 / `popularity` 실참여자 수 전환**: ADR 0003 "향후 변경"에 있던 항목. 확정 C-1이 **이번에도 재결정하지 않기로** 확정했다(시드 20건 전부 `capacity` NULL이라 정원 개념이 데모에 없다). "참여 확정"(QR 입장 인증)이 정의된 뒤 재검토. **어떤 경우에도 학생 단위 랭킹으로 파생하지 않는다**(CLAUDE.md 2장 1번).
- **아카이브·마이페이지의 참여 이력 표시**: `participations_select_own`이 이미 필요한 권한을 준다(추가 정책 불필요). 표시 자체는 각 스펙 몫.

## 케빈 확인 필요 → **해소 완료 (2026-07-16, 두 항목 모두 이 ADR대로 확정)**

**1번(QR 컬럼 4개 선반영), 2번(`participation_status` 3종) 모두 채택.** 근거는 "미리 만들면 편해서"가 아니라 아래 논리가 성립하기 때문이다:

> RLS `with check`는 행 단위 술어라 **존재하지 않는 컬럼을 미리 금지할 수 없다.** 컬럼을 QR 스펙에서 추가하면 그 시점의 `participations_insert_own`이 새 컬럼을 언급하지 않으므로 학생이 토큰을 심거나 `entry_at`을 채우는 경로가 **조용히 열린다.** 즉 이 4개 컬럼은 봉인의 대상이 아니라 **봉인을 SQL로 표현하기 위한 전제**다.

`participation_status` 3종도 같은 맥락 — 값이 1종뿐이면 `status = 'applied'` 술어가 자명해 보여 삭제 유혹이 생기는데, 그 술어가 자물쇠다. 두 결정 모두 사용자에게 보이는 변화가 없고, QR 스펙에서 상태 기계를 확정할 때 값 이름/개수는 조정될 수 있다(`alter type add value` 또는 rename).

**후속 에이전트는 재논의하지 말 것.** 아래는 결정 근거 원문이다.

## 케빈 확인 필요 원문 (해소 완료 — 위 참고)

1. **`entry_at`/`exit_at`/`entry_token`/`exit_token` 4개 컬럼을 이번에 만든다.** 이번 스코프에서는 **값이 절대 채워지지 않는 컬럼 4개**가 생긴다(전부 NULL 고정). 이유는 위 결정 3번 — 컬럼이 있어야 "학생이 이걸 직접 못 채운다"를 RLS로 못박을 수 있고, 그게 이번 스펙의 핵심 요구사항(이슈 1)이다. ADR 0002가 `points_balance` 등을, ADR 0003이 `popularity`를 같은 방식으로 선반영한 전례를 따랐다.
2. **`participation_status` 값 3종(`applied`/`entered`/`completed`)을 지금 정의한다.** 이번엔 `applied`만 생성된다. CLAUDE.md 6장 QR 흐름에서 기계적으로 도출한 값이며, QR 스펙에서 상태 기계를 확정할 때 이름/개수가 조정될 수 있다(그때는 `alter type add value` 또는 rename).

> 두 항목 모두 "지금 안 쓰는 것을 미리 만드는" 판단이라 표시한다. 반대하시면 QR 스펙에서 컬럼 추가와 정책 개정을 **반드시 한 마이그레이션에서 함께** 해야 한다는 조건이 붙는다.

## 영향받는 코드 위치
- `docs/db/schema.sql` — `participation_status` enum + `participations` DDL + RLS 정책 2개 (본 ADR로 갱신 완료. backend-agent는 이 파일을 마이그레이션으로 변환)
- `supabase/migrations/{타임스탬프}_add_participations.sql` — **backend-agent** 신규 작성
- `scripts/` — **변경 없음.** 시드 추가하지 않는다(스펙 "추가 시드 불필요" — 신청은 앱에서 학생이 직접 만든다)
- `src/lib/programService.js` — **frontend-agent** 확장 (아래 구현 가이드)
- `src/pages/StudentProgramsPage.jsx` — **frontend-agent** (placeholder 대체)
- `src/pages/StudentHomePage.jsx` — **frontend-agent** (D-1 반영은 `programService` 안에서 끝나면 이 파일 변경 없음)
- `src/components/student/ProgramCard.jsx`, `src/components/Modal.jsx`, 토스트 컴포넌트(신규), `src/components/Icon.jsx` — **frontend-agent** (스펙 `docs/specs/student-programs.md` D절)

## 구현 가이드

### backend-agent가 구현할 부분
1. **마이그레이션** `supabase/migrations/{타임스탬프}_add_participations.sql` — `docs/db/schema.sql`의 4번 절을 그대로 옮긴다. `20260716120000_add_programs_and_career_track.sql`의 주석 관례를 따를 것(특히 `[RLS 권한 경계]` 블록 형식 — 대상 역할 / 허용 행 / 불가능 / 용도).
   - enum 1종 생성: `participation_status` (기존 `do $$ ... exception when duplicate_object $$` 패턴 사용)
   - `create table public.participations (...)` + `comment on` + `alter table ... enable row level security`
   - 정책 **2개만**: `participations_select_own`, `participations_insert_own`. **둘 다 `to authenticated` 필수.**
   - **`with check`는 위 "RLS/권한 영향"의 6절을 한 절도 빼지 말 것.** 특히 `status = 'applied'`와 토큰 NULL 절은 지금 무의미해 보여도 QR 스펙의 부정 적립을 막는 자물쇠다 — 주석으로 그 이유를 남길 것.
   - **update/delete 정책, admin 정책, 포인트 지급 트리거를 추가하지 말 것** (의도적 결정).
   - 인덱스 추가 금지. `unique (student_id, program_id)`가 만드는 인덱스가 유일하며, 이것이 `student_id` 조회도 커버한다.
2. **시드 없음.** `scripts/`를 건드리지 않는다. 시연 리셋 절차(`delete from public.participations;`, service_role)를 마이그레이션 하단 주석에 남길 것.
3. 적용 후 **실제로 뚫어볼 것** (학생 계정 anon 키 기준, service_role 금지):
   - `insert {student_id: 남의 uuid, program_id}` → 403
   - `insert {student_id: 본인, program_id, status: 'completed'}` → 403
   - `insert {student_id: 본인, program_id, entry_at: now()}` / `entry_token: 'x'` → 403
   - 같은 `program_id`로 2회 insert → 두 번째 409
   - `is_published = false`인 프로그램 uuid로 insert → 403
   - 학생 B로 로그인 후 `select * from participations` → 학생 A의 행이 안 보임(0행)

### frontend-agent가 구현할 부분
1. **`src/lib/programService.js` 확장**:
   - `fetchAllPrograms()` — 선택 화면용. `.eq('is_published', true)`만 걸고 **`date` 필터를 걸지 않는다**(지난 프로그램 그룹이 필요). select 목록에 홈의 `CARD_FIELDS` + **`description`**(팝업) + **`popularity`**(인기순 정렬) + **`created_at`**(최신순 정렬)을 추가한다. 정렬이 클라이언트에서 토글되므로 `popularity`/`created_at`을 페이로드에 실어야 한다(서버 `.order()`로 하면 정렬 변경마다 재조회가 된다).
     - **[원칙 가드] `popularity`는 정렬 입력으로만 쓴다. 숫자를 화면에 렌더하지 말 것.** 신청자 수·순위 라벨("TOP 3", "인기 1위", "N명 신청") 금지 — 스펙 "절대 원칙 체크" 참고. 홈(`fetchRecommendedPrograms`)은 이 필드를 계속 가져오지 않는다.
   - `fetchMyParticipations()` — `select('id, program_id, status')`. RLS가 본인 행만 내려주므로 **`student_id` 필터를 클라이언트에서 걸 필요가 없다**(걸어도 무해하나 경계의 소유자는 RLS다).
   - `applyToProgram(programId)` — `insert({ student_id: user.id, program_id: programId })`.
     - **`student_id`와 `program_id` 외에 어떤 컬럼도 보내지 말 것.** `status`/`entry_at`/토큰/`created_at`을 보내면 RLS 또는 default와 충돌한다. `status`는 DB default(`'applied'`)가 채운다.
     - `student_id`는 **AuthContext의 본인 id**를 넣는다(`auth.uid()`와 일치해야 통과).
   - `fetchRecommendedPrograms(profile, limit = 8)` **수정 (D-1)** — 내부에서 `Promise.all([기존 programs 쿼리, fetchMyParticipations()])` 후, `program_id` Set에 포함된 프로그램을 **`slice(0, limit)` 이전에** 제외. **`status`를 조건에 넣지 말 것**(`entered`/`completed`도 제외 대상이다). 나머지(계열 매칭 우선 + 최신순, `isMatched` 플래그)는 그대로.
2. **에러 처리** (스펙: "신청 실패 시 조용히 넘어가지 않고 사용자에게 알린다"):
   | 상황 | Postgres 코드 / HTTP | 처리 |
   |---|---|---|
   | 중복 신청 (두 탭·새로고침 경합) | `23505` / 409 | 실패로 알리되 문구는 "이미 신청한 프로그램이에요" 계열. 화면 상태를 "신청됨"으로 동기화 |
   | RLS 위반 (정상 사용에선 발생 불가 — 발생하면 버그) | `42501` / 403 | 일반 실패 문구. 콘솔에 원본 에러 로그 |
   | 네트워크/기타 | — | 일반 실패 문구 |
   - **낙관적 업데이트를 하더라도 실패 시 반드시 롤백할 것** — "신청됨"으로 보이는데 DB에 없으면 새로고침 시 되돌아가 인수 조건("새로고침해도 신청됨 유지")을 깬다.
3. **버튼 비활성 규칙은 프런트가 소유한다** (DB는 검사하지 않는다 — 위 "넣지 않는 이유"):
   - 이미 신청함(`fetchMyParticipations` 결과) → `이미 신청했습니다` / 카드 `신청됨`
   - `STATUS[status].join === false` → `{라벨} — 신청할 수 없습니다`
   - `date < todayISO()` (H-1) → `이미 종료된 활동입니다`. **`todayISO()`는 로컬(KST) 기준** — `toISOString()` 금지(ADR 0003 6번 타임존 주의).
4. **`participations.status`를 화면 로직에 쓰지 말 것** (이번 스코프). 값이 항상 `applied`라 분기가 의미 없고, QR 스펙에서 이 컬럼의 의미가 확정된다. "신청됨" 판정은 **행의 존재 여부**로만 한다.
5. **신청 후 `points_balance`를 건드리는 코드를 만들지 말 것** — 포인트는 QR 퇴장 인증에서만 지급된다(CLAUDE.md 2장 3번 / 6장 3번). 인수 조건에 시각 점검 항목으로 들어 있다.
