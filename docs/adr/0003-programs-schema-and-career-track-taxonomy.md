# ADR 0003: programs 스키마 및 계열(career_track) taxonomy 확정

## 상태
확정 (일부 항목 "케빈 확인 필요" 표시 — 블로킹 아님)

## 배경
`docs/specs/student-home.md`에서 학생 홈 화면이 확정됐고, "확정된 결정 A~F"(2026-07-16, 케빈 승인)가 이미 정해져 있다. 이 ADR은 그 결정을 전제로, 실제 SQL로 확정되지 않은 부분만 다룬다.

`programs`는 CLAUDE.md 5장에 필드 목록만 있고 SQL로 구체화된 적이 없다. 이번 기능에서 처음 생성한다. 확정 D에 따라 `org`, `career_track`, `popularity`(정적), `status`(정적)를 기본 필드에 추가한다.

핵심 쟁점은 **확정 E(계열 매칭 추천)의 정합성**이다. E가 동작하려면 `profiles.career_interest`와 `programs.career_track`이 같은 값 공간이어야 하는데, ADR 0002가 확정한 `career_interest`는 자유 텍스트 `text`다. 두 축이 문자열로만 느슨하게 이어지면 매칭이 조용히 실패한다(오타 하나로 배지가 안 뜨고 에러도 안 남). 이 ADR은 그 축을 DB 레벨에서 강제로 일치시키는 방법을 확정한다.

## 결정 (스키마 변경 포함)
전체 SQL은 `docs/db/schema.sql`. 요약:

### 1. 값 집합은 enum 3종으로 확정 (text + CHECK 기각)

`career_track`(5종), `program_category`(8종), `program_status`(5종)을 모두 **enum 타입**으로 만든다. 근거:

1. **전례 일관성** — 기존 마이그레이션이 `user_role`을 enum으로 선언했다. 같은 성격(작고 닫힌 값 집합)을 다른 방식으로 다룰 이유가 없다.
2. **확정 F로 값 집합이 닫혔다** — "카테고리 8종 유지 / TRACK 5종 유지"가 승인 완료라, enum의 최대 단점(값 추가·삭제 비용)이 이 프로젝트에서 실현될 가능성이 낮다.
3. **오타 차단** — 시드 16~20건을 수기로 넣는데 `hbk`를 `hkb`로 잘못 쓰면 text+CHECK 없이는 조용히 통과하고, 프런트 `CAT[p.category]`가 `undefined`가 되어 카드가 깨진다. enum은 insert 시점에 거부한다.
4. **(가장 중요) 두 축의 값 공간을 DB가 보장한다** — `programs.career_track`과 `profiles.career_interest`가 **같은 `career_track` 타입**을 공유하면, 두 컬럼이 같은 값 집합을 갖는다는 것이 구조적으로 강제된다. text+CHECK로 하면 CHECK 목록 2개가 각각 존재하고 한쪽만 수정되는 드리프트가 가능하다. E의 매칭이 성립하는 근거를 주석/규칙이 아니라 타입 시스템에 두는 쪽을 택했다.

값 추가가 필요해지면 `alter type ... add value`로 가능하다(PG12+, 단 트랜잭션 밖에서 실행 후 별도 트랜잭션에서 사용). 값 삭제/rename은 비용이 크지만, F가 확정이라 수용 가능한 리스크로 본다.

### 2. 카테고리 taxonomy — `program_category` (8종, 프로토타입 키 그대로)

| enum 값 | 구분 | 표시명 |
|---|---|---|
| `hbk` | 교내 | 방과후 |
| `hdo` | 교내 | 동아리 |
| `hdc` | 교내 | 대회 |
| `het` | 교내 | 기타 |
| `ecp` | 교외 | 기업·국가기관 |
| `evo` | 교외 | 봉사활동 |
| `edc` | 교외 | 대회 |
| `eet` | 교외 | 기타 |

**프로토타입 키(`hbk` 등)를 그대로 enum 값으로 쓴다.** `in_afterschool` 같은 가독성 높은 값도 검토했으나 기각: 프런트엔드는 어차피 `category → {group, name, color, icon, soft}` 맵이 필요하고(색상/아이콘은 DB에 둘 성격이 아님), 그 맵은 프로토타입 `CAT`(692~701줄)을 그대로 재사용하는 게 가장 안전하다. DB 값과 맵 키가 다르면 그 사이에 변환 계층이 하나 생기고 거기가 버그 자리가 된다. 확정 F의 "프로토타입 taxonomy 그대로 사용"도 이 해석과 일치한다.

**교내/교외 그룹을 별도 컬럼으로 쪼개지 않는다.** 대회·기타가 양쪽에 있어 (group, name) 2컬럼도 가능하지만, CLAUDE.md 5장이 단일 `category` 필드로 정의했고 그룹은 프런트 `CAT` 맵에서 파생 가능하다. 과설계 회피.

### 3. 계열 taxonomy — `career_track` (5종) + **profiles.career_interest 정합성 (핵심 결정)**

| enum 값 | 표시명 |
|---|---|
| `sci` | 이공계·자연과학 |
| `it` | IT·소프트웨어 |
| `hum` | 인문·사회 |
| `biz` | 경영·경제 |
| `art` | 예술·체육 |

**`profiles.career_interest`를 `text` → `career_track` enum으로 좁힌다. 이것이 ADR 0002의 profiles 스키마를 수정하는 유일한 지점이다.**

- 마이그레이션 방식: `create table`이 아니라 **`alter table public.profiles alter column career_interest type career_track using career_interest::career_track;`** (DB에 이미 `20260709120000_init_profiles_and_mentor_students.sql`이 적용된 상태이므로).
- **캐스팅 안전성 확인 완료**: `scripts/seed-accounts.mjs`(142~147줄)는 `id, role, code, name`만 insert한다. 즉 현재 모든 profiles 행의 `career_interest`는 NULL이고, 이 컬럼에 값을 쓰는 경로는 앱 어디에도 없다(profiles에 update 정책이 0개). NULL만 있는 컬럼의 타입 캐스팅은 실패하지 않는다. 만약 backend-agent가 적용 시 캐스팅 에러를 만나면 = 예상 밖의 값이 들어있다는 뜻이므로 중단하고 케빈에게 보고할 것.
- **nullable 유지**: 확정 E가 "career_interest가 비어 있으면 최신순 fallback"을 명시하므로 NULL은 유효한 도메인 상태다. 또 `profiles`는 학생/관리자 공통 테이블이고 계열은 학생 전용 개념이라 NOT NULL이 애초에 불가능하다.
- **"admin은 career_interest가 NULL이어야 한다"를 CHECK로 강제하지 않는다.** `mentor_students`의 role 정합성을 트리거로 강제하지 않은 ADR 0002의 판단과 같은 이유(데모 규모, 시딩 스크립트 책임).

이 결정으로 E의 매칭은 `programs.career_track = profiles.career_interest` 라는 **동일 타입 간 비교**가 되고, 오타로 매칭이 조용히 실패하는 경로가 사라진다.

> **ADR 0002 수정 범위**: profiles의 나머지 결정(id/role/code/name, 가상 이메일 규칙, 로그인 검증 흐름, RLS `profiles_select_own`)은 전부 그대로 유효하다. 변경은 `career_interest` 컬럼 타입 1건뿐이며, ADR 0002 문서에도 이 ADR을 가리키는 갱신 주석을 추가했다. supersede가 아니라 부분 수정이다.

### 4. `status` 값 집합 — `program_status` (5종, 정적 필드)

확정 D에 따라 참여수/정원 파생이 아니라 **정적 필드**로 저장한다(`participations` 테이블이 아직 없음).

| enum 값 | 표시 라벨 | 의미 | 프로토타입 `join` |
|---|---|---|---|
| `open` | 참석 가능 | 신청 가능 | true |
| `ing` | 참석 중 | 진행 중 | false |
| `wait` | 대기 | 정원이 찼지만 대기 신청 가능 | true |
| `full` | 마감 | 모집 기한 종료 | false |
| `over` | 정원 초과 | 정원이 다 참 | false |

`full`/`over`는 의미가 겹쳐 보이지만 프로토타입 라벨(`full`→"마감", `over`→"정원 초과")을 그대로 보존했다. 홈 화면에서 status는 **표시 전용**이다(참여 버튼 라벨/비활성). 신청 가능 여부(`join`) 매핑은 DB가 아니라 프런트 `STATUS` 맵(프로토타입 710~716줄)이 소유한다 — 실제 신청 로직은 참여 팝업 스펙 몫이라 지금 DB에 넣을 근거가 없다.

**홈 추천에서 status로 필터링하지 않는다.** 프로토타입 `recommended()`(837줄)는 `STATUS[p.status].join`인 것만 풀에 넣지만, PM 스펙의 기능 요구사항/인수 조건은 제외 조건으로 `is_published`와 지난 날짜만 명시하고 status는 "메인 화면은 표시만 필요"로 적었다. 스펙을 따른다(= `ing`/`full`/`over` 프로그램도 추천에 노출되되 버튼이 비활성으로 표시됨). 프로토타입이 함께 걸던 `!isJoined && !isCompleted` 필터는 `participations`가 없어 이번엔 적용 불가.

### 5. programs 테이블 — 컬럼 확정

| 컬럼 | 타입 | 제약 | 근거 |
|---|---|---|---|
| `id` | uuid | PK, `default gen_random_uuid()` | `mentor_students` 전례 |
| `category` | `program_category` | not null | CLAUDE.md 5장 |
| `title` | text | not null | 〃 |
| `description` | text | not null | 〃. 프로토타입 전 프로그램에 설명이 있고 참여 팝업에서 필수 표시 |
| `org` | text | not null | 확정 D. 모든 카드에 표시(`p.org`)되므로 필수 |
| `date` | date | not null | CLAUDE.md 5장. 표시 포맷("7월 16일 (목)")은 프런트가 생성 |
| `time` | **text** | not null | CLAUDE.md 5장. **`time` 타입이 아니다** — 아래 주의 참고 |
| `capacity` | integer | nullable, `check (capacity is null or capacity > 0)` | CLAUDE.md 5장. NULL = 정원 미정/무제한 |
| `points` | integer | not null, `check (points between 150 and 3000 and points % 10 = 0)` | CLAUDE.md 7장 포인트 규칙을 DB로 강제 |
| `career_track` | `career_track` | not null | 확정 D/E. 계열이 없는 프로그램은 매칭 축에서 누락되므로 필수 |
| `popularity` | integer | not null, default 0, `check (popularity >= 0)` | 확정 D (정적) |
| `status` | `program_status` | not null, default `'open'` | 확정 D (정적) |
| `is_published` | boolean | not null, **default true** | CLAUDE.md 5장 |
| `created_by` | uuid | nullable, `references profiles(id) on delete set null` | CLAUDE.md 5장 |
| `created_at` | timestamptz | not null, default now() | 아래 근거 참고 |

**주의 1 — `time`은 text다.** 프로토타입 값이 `"15:30–17:00"`뿐 아니라 `"방과후"`, `"점심·방과후"`, `"온라인 접수"`, `"무박 2일"`, `"협의"`, `"마감 18:00"`이다. Postgres `time` 타입으로는 표현 불가하며, 이건 시각이 아니라 **표시용 자유 텍스트**다. `date`/`time` 둘 다 Postgres 비예약어라 컬럼명으로 사용 가능하다(CLAUDE.md 5장 명칭 유지).

**주의 2 — `created_at`은 임의 추가가 아니다.** CLAUDE.md 5장 programs 필드 목록에는 없지만, 확정 E의 "최신순"이 성립하려면 시간 축이 반드시 필요하고 uuid PK는 생성 순서를 담지 못한다. 또 ADR 0002가 `profiles`/`mentor_students`에 동일하게 `created_at timestamptz not null default now()`를 추가한 전례가 있다. 두 근거로 추가한다.

**주의 3 — `is_published` 기본값 true.** CLAUDE.md 10장 관리자 기능이 "올리기(게시)/내리기(게시중단)"라 등록 = 게시가 도메인 기본값에 맞다. 시드는 값을 명시적으로 넣는다. 관리자 프로그램 관리 스펙에서 초안(draft) 개념이 필요해지면 그때 재검토.

**주의 4 — 인덱스를 만들지 않는다.** 데모 데이터가 16~20행이라 PK 외 인덱스는 순수 노이즈다. backend-agent는 `is_published`/`date`/`career_track`에 인덱스를 추가하지 말 것(의도적 결정).

**`popularity` — 절대 원칙 가드**: 이 값은 **프로그램의 인기 지표이며 학생 간 순위가 아니다.** 학생별 집계·정렬·랭킹으로 파생시키는 어떤 설계도 금지(CLAUDE.md 2장 1번). 홈 화면은 이 값을 **표시하지도, 정렬에 쓰지도 않는다**(정렬은 아래 6번의 E 규칙). 확정 D에 따라 컬럼만 미리 두고, 실제 사용처는 프로그램 선택 화면의 "인기순" 정렬(프로토타입 `sortProgs`)이다.

### 6. 추천 쿼리 — 클라이언트 정렬 (뷰/RPC 기각)

**단순 select + 클라이언트 정렬**로 확정한다.

```
select id, category, title, org, date, time, points, career_track, status
from programs
where is_published = true       -- RLS와 중복이지만 의도를 코드에 명시 (이중 안전장치)
  and date >= {오늘}            -- 지난 날짜 제외
order by created_at desc
limit 50                        -- 안전 상한. 데모 실제 행 수는 16~20
```
→ 클라이언트에서 `career_track === profile.career_interest`인 것을 앞으로 당기고(그룹 내 순서는 위 `created_at desc` 유지), 상위 8개만 렌더(프로토타입 `recommended(8)`와 동일).

기각 사유:
- **뷰**: Postgres 뷰는 기본이 정의자(owner) 권한으로 실행된다(PG15+의 `security_invoker`를 켜지 않는 한). `profiles`를 조인하는 뷰를 무심코 만들면 `profiles_select_own` 경계를 우회해 **다른 학생의 계열/이름이 새는 함정**이 있다. 권한 경계를 흐리면서까지 얻을 이득이 없다.
- **RPC**: DB 객체가 늘고 정렬 규칙 수정 비용이 커진다. 아래 "케빈 확인 필요" 항목대로 정렬 규칙이 바뀔 여지가 있어 JS에 두는 편이 싸다.
- 매칭 배지(`isMatched`)는 어차피 클라이언트가 `career_interest`(AuthContext의 본인 profile)를 알아야 계산하므로, 정렬만 SQL로 빼면 같은 규칙이 두 레이어에 쪼개진다.
- 16~20행 전량 fetch 비용은 무시 가능.

**타임존 주의**: `{오늘}`은 **로컬(KST) 기준 `YYYY-MM-DD`** 문자열이어야 한다. `new Date().toISOString().slice(0,10)`은 UTC 변환이라 KST 오전 9시 이전에 날짜가 하루 밀린다 — 사용 금지. 인수 조건 "캘린더 기본값 = 실제 오늘 날짜"와 같은 소스를 쓸 것.

`date >= 오늘`이므로 "오늘 이미 끝난 프로그램"도 노출된다 — 프로토타입(`p.d>=TODAY_ISO`)과 동일한 동작이라 의도적으로 맞췄다.

## RLS/권한 영향

### 이번에 추가하는 정책: 1개뿐
```
[RLS 권한 경계] programs_select_published
  대상 역할: authenticated (student, admin 공통)
  허용 행: is_published = true 인 행만 select
  불가능: 미게시(is_published = false) 행 조회, 모든 insert/update/delete
```
- **`to authenticated`를 명시한다.** `using (is_published = true)`만 쓰고 `to` 절을 생략하면 기본 대상이 `public` 역할이라 **로그인하지 않은 anon 키 보유자도 전체 프로그램 목록을 읽을 수 있다.** 개인정보는 아니지만 앱의 모든 프로그램 화면이 로그인 뒤에 있는데 데이터만 밖에 열어둘 이유가 없다. (`profiles_select_own`은 `auth.uid() = id` 조건 자체가 anon을 걸러내서 `to` 절이 없어도 안전했다 — programs는 그 방어가 없으므로 명시가 필요하다.)
- insert/update/delete 정책 0개 = 전체 거부. 시드는 service_role이라 RLS를 우회하므로 이번 기능 동작에 지장 없다.

### 관리자(admin) 정책은 이번에 넣지 않는다 — 근거
- **전례**: 기존 마이그레이션이 `mentor_students`에 정책을 0개 둔 이유("이번 스코프에 조회할 일이 없음")와 같은 원칙 — 필요할 때 여는 것이 안전하다.
- 관리자 프로그램 관리 화면은 **이번 스코프가 아니고 스펙조차 없다.** 지금 "본인이 만든 행만(`created_by = auth.uid()`)" vs "전체"를 고르면 근거 없는 추측이 된다(데모 관리자가 1명이라 둘이 사실상 같아 보이지만, 그렇다고 아무거나 열어둘 이유는 없다).
- 정책을 미리 넣으면 **쓰이지 않는 쓰기 권한이 열린 채로 남는다.** 프로그램 관리 스펙이 올 때 별도 ADR로 추가한다(그때 미게시 행에 대한 admin select 가시성도 함께 정해야 한다 — 위 정책은 admin에게도 미게시 행을 감춘다).

### 이번 변경이 만드는 노출 경로 재검토 (결론: 없음)
- `programs`에는 개인정보가 없다. 학생이 published 프로그램을 보는 것은 기능 그 자체다.
- `created_by`로 관리자의 uuid가 노출되지만, `profiles`는 여전히 `profiles_select_own` 하나뿐이라 **uuid를 이름/코드로 조인할 경로가 없다.** 불투명 식별자만 보이며 실질 정보 없음.
- **`career_interest` 타입 변경이 노출을 만들지 않는다.** 학생은 여전히 본인 profiles 행만 읽고, 매칭은 본인 `career_interest`로 클라이언트에서 수행된다. 다른 학생의 계열을 볼 경로 없음.
- **`popularity`는 학생 단위 데이터가 아니다.** 프로그램 속성이라 학생 프라이버시와 무관.

### 다음 스펙에서 필요해질 정책 (지금은 미구현)
- **마이페이지(계열 선택 UI)**: `profiles`에 "본인 행 update, 단 `career_interest` 컬럼 한정" 정책이 필요하다. 현재 profiles는 update 정책이 0개라 **앱에서 계열을 저장할 방법이 없다** — 그래서 이번 데모용 계열 값은 시딩으로만 넣는다(아래 참고).
- **프로그램 관리**: admin insert/update 정책 + 미게시 행 select 정책.

## 시드 설계 (backend-agent 요구사항)

확정 F(16~20개) 기준. 인수 조건을 실제로 검증 가능하게 하려면 아래가 **필수**다:

1. **`is_published = true` + 미래 날짜 행이 8개 이상** — 홈이 카드 8장을 채워야 함.
2. **`is_published = false` 행 1개 이상** — 인수 조건 "미게시 제외" 검증용.
3. **`date < 오늘` 행 1개 이상** — 인수 조건 "지난 날짜 제외" 검증용.
4. **날짜는 프로토타입 리터럴(2026-03~08)을 그대로 쓰지 말고 `오늘 ± n일` 상대값으로 생성할 것.** 프로토타입은 `TODAY_ISO='2026-07-02'` 고정 전제라 리터럴 날짜가 유효했지만, 실제 DB 시드에 박아두면 케빈이 몇 주 뒤 시연할 때 전부 과거가 되어 홈이 빈 상태로 뜬다(인수 조건 붕괴). 제목/주최/설명/포인트/계열은 프로토타입(720~761줄)에서 그대로 가져오되 날짜만 상대값으로.
5. **주 데모 계정의 계열과 일치하는 미래·게시 프로그램이 3개 이상** — "내 관심 계열" 배지가 여러 장 보여야 E가 시연된다.
6. 시드 위치: **`scripts/seed-programs.mjs` (Node, service_role)**, 마이그레이션이 아니라 스크립트. 근거: (a) `created_by`를 데모 관리자(`ADM-0001`)의 uuid로 채우려면 `seed-accounts.mjs` 실행 후 조회가 필요하고, (b) 4번의 상대 날짜 계산이 JS에서 자연스럽고, (c) "스키마는 마이그레이션, 데모 데이터는 scripts/"라는 ADR 0002의 관례와 일치한다. `seed-accounts.mjs` 다음에 실행.

### `career_interest` 시딩 — 이게 없으면 E를 시연할 수 없다 (중요)
현재 데모 학생 5명은 전원 `career_interest`가 NULL이고(seed-accounts.mjs가 넣지 않음), 계열 선택 UI는 마이페이지 스펙이라 이번 스코프가 아니며, `profiles`에 update 정책이 없어 앱에서 저장할 수도 없다. **즉 시딩하지 않으면 홈은 100% 최신순 fallback으로만 동작하고, 인수 조건 "일치하는 프로그램이 앞에 오고 배지가 붙는다"를 검증할 방법이 없다.**

backend-agent는 `scripts/seed-accounts.mjs`의 `DEMO_ACCOUNTS`에 `career_interest`를 추가하고 profiles insert에 함께 넣을 것. 제안 값(**값 배정은 케빈 확인 가능, 블로킹 아님**):

| 코드 | 이름 | career_interest | 의도 |
|---|---|---|---|
| 10718 | 신지훈 | `it` | 주 데모 계정 (프로토타입 원본 예시). IT 프로그램이 시드에 가장 많음 |
| 10719 | 김도윤 | `sci` | |
| 10720 | 이서연 | `hum` | |
| 10721 | 박민준 | `biz` | |
| 10722 | 최하은 | **NULL** | 최신순 fallback 경로 시연용 (E의 빈 값 분기) |
| ADM-0001 | 정하윤 | NULL | 관리자 = 계열 개념 없음 |

`career_interest`는 CLAUDE.md 5장·ADR 0002에 이미 존재하는 필드이므로 임의 추가가 아니다. 시드 값 지정만 이번에 결정한다.

## 대안으로 고려했던 것
- **text + CHECK 제약** (카테고리/계열/상태): 값 변경이 쉬운 건 장점이나, `career_interest`와 `career_track`에 각각 CHECK를 걸어야 해서 두 목록이 드리프트할 수 있다. E의 정합성을 타입으로 보장하는 쪽이 낫다고 판단해 기각. `user_role` enum 전례와도 어긋난다.
- **가독성 높은 enum 값**(`in_afterschool`, `ex_volunteer` 등): DB만 보면 명확하지만 프런트 `CAT` 맵 키와 달라져 변환 계층이 생긴다. 확정 F("프로토타입 taxonomy 그대로")와도 어긋나 기각.
- **category를 (group, name) 2컬럼으로 분리**: CLAUDE.md 5장이 단일 `category`로 정의했고 그룹은 프런트 맵에서 파생 가능. 과설계로 기각.
- **`career_interest`를 자유 텍스트로 두고 문자열 비교**: 마이그레이션이 필요 없지만, 오타/표기 흔들림에 매칭이 조용히 실패하고 에러도 안 난다. E가 핵심 기능이라 기각.
- **`career_interest`를 다중 계열(배열/조인 테이블)로**: 프로토타입은 `state.interestTracks`가 **배열**이라 다중 선택이었다. 그러나 CLAUDE.md 5장·PM 스펙 모두 "단일 계열"로 적고 있고, 다중은 profiles 스키마를 더 크게 흔든다. 단일 유지로 기각(아래 "향후 변경" 참고).
- **뷰 / RPC로 추천 정렬**: 위 6번 근거로 기각(RLS 우회 함정 + 수정 비용).
- **`popularity`를 `participations` 카운트 집계로**: `participations` 테이블 자체가 없어 불가능. 확정 D가 정적 필드로 확정.
- **`status`를 (date + capacity + 참여수) 파생으로**: 동일한 이유로 이번엔 불가. 확정 D.
- **admin RLS 정책 선반영**: 스펙이 없는 상태에서 권한 경계를 추측하게 되고, 안 쓰는 쓰기 권한이 열린 채 남는다. 기각.

## 향후 변경 (이번 스코프 아님, 예정만 기록)
- **`status` → 파생으로 전환**: `participations`가 생기면 `open/wait/full/over`는 (`date`, `capacity`, 참여 확정 수)로 계산 가능해지고, `ing`는 `date`/`time` 기반이 된다. 그때 정적 컬럼을 유지할지(관리자 수동 오버라이드) 계산값으로 대체할지 재결정한다. 값 집합 자체는 유지될 가능성이 높다.
- **`popularity` → 실제 참여자 수 기반**: 동일하게 `participations` 도입 시 재검토. 단, **어떤 경우에도 학생 단위 랭킹으로 파생하지 않는다**(CLAUDE.md 2장 1번).
- **추천 풀에서 이미 신청/완료한 프로그램 제외**: 프로토타입 `recommended()`의 `!isJoined && !isCompleted` 필터. `participations` 도입 시 추가.
- **계열 다중 선택**: 프로토타입은 배열이었다. 마이페이지 계열 선택 UI 스펙에서 다중이 필요하다고 판단되면 `career_interest career_track` → `career_interests career_track[]`로 확장하고 매칭을 `= ANY`로 바꾼다. 지금은 단일로 확정.
- **`programs` admin RLS 정책 / `profiles` update 정책**: 위 "RLS 영향" 참고.

## 케빈 확인 필요 → **해소 완료 (2026-07-16, 케빈 확정)**
1. **추천 정렬의 그룹 내 순서 — 최신순으로 확정.** 이 ADR의 기본 해석(**(1) 계열 일치 우선 → (2) `created_at desc`**)을 그대로 채택한다. 프로토타입 `recommended()`의 인기순(`pop desc`)은 채택하지 않는다. 즉 `popularity`는 이번 스코프에서 저장만 되고 정렬에도 표시에도 쓰이지 않는다. (검토 근거는 아래 원문 유지: 프로토타입 재현보다 확정 E 문구와의 일치를 우선함.)
2. **데모 학생 5명의 `career_interest` 값 배정 — 위 표대로 확정.** 10718=`it`(주 데모), 10719=`sci`, 10720=`hum`, 10721=`biz`, 10722=NULL(fallback 시연), ADM-0001=NULL. backend-agent는 이 표 그대로 시딩할 것.

> 위 2건은 확정이므로 backend/frontend-agent는 재논의 없이 진행할 것.

## 영향받는 코드 위치
- `docs/db/schema.sql` — enum 3종 + `programs` DDL + RLS 정책, `profiles.career_interest` 타입 반영 (본 ADR로 갱신 완료. backend-agent는 이 파일을 마이그레이션으로 변환)
- `supabase/migrations/{타임스탬프}_add_programs_and_career_track.sql` — **backend-agent** 신규 작성
- `scripts/seed-programs.mjs` — **backend-agent** 신규 작성 (위 "시드 설계" 그대로)
- `scripts/seed-accounts.mjs` — **backend-agent** 수정 (`DEMO_ACCOUNTS`에 `career_interest` 추가)
- `src/lib/programService.js` — **frontend-agent** 신규 (위 6번 쿼리 + 정렬)
- `src/pages/StudentHomePage.jsx`, 학생 공통 셸 컴포넌트 — **frontend-agent** (스펙 `docs/specs/student-home.md`)
- `docs/adr/0002-profiles-schema-and-login-verification.md` — `career_interest` 타입 변경 갱신 주석 추가 (완료)

## 구현 가이드

### backend-agent가 구현할 부분
1. **마이그레이션** `supabase/migrations/{타임스탬프}_add_programs_and_career_track.sql` — `docs/db/schema.sql` 그대로 옮기되, 기존 마이그레이션의 주석 관례(특히 `[RLS 권한 경계]` 블록)를 따를 것.
   - enum 3종 생성: `career_track`, `program_category`, `program_status` (기존 `do $$ ... exception when duplicate_object $$` 패턴 사용)
   - **`profiles.career_interest` 타입 변경은 `alter table ... alter column ... type career_track using career_interest::career_track`** — `create table if not exists`로는 반영되지 않는다(테이블이 이미 존재). 캐스팅 에러 발생 시 중단하고 보고.
   - `create table public.programs (...)` + `comment on` + `alter table ... enable row level security`
   - 정책은 `programs_select_published` **1개만**. `to authenticated` 절 필수. admin 정책 추가 금지.
   - 인덱스 추가 금지 (PK만).
2. **`scripts/seed-accounts.mjs` 수정** — `DEMO_ACCOUNTS`에 `career_interest` 필드 추가 후 profiles insert에 포함. 값은 위 표.
3. **`scripts/seed-programs.mjs` 신규** — 위 "시드 설계" 1~6번 전부 충족. `seed-accounts.mjs` 스타일(.env.seed 로더, service_role 클라이언트, 실패 시 즉시 중단) 재사용. `created_by`는 `profiles`에서 `code = 'ADM-0001'` 행의 id를 조회해 채운다.
4. 실행 순서를 README/주석에 명시: 마이그레이션 → `seed-accounts.mjs` → `seed-programs.mjs`.

### frontend-agent가 구현할 부분
1. **`src/lib/programService.js` 신규** — `fetchRecommendedPrograms(profile, limit = 8)`:
   - 쿼리: `.eq('is_published', true).gte('date', todayISO).order('created_at', { ascending: false }).limit(50)`
   - `todayISO`는 **로컬 타임존 기준** `YYYY-MM-DD` (`toISOString()` 금지 — 위 6번 타임존 주의)
   - `profile.career_interest`가 있으면 일치 항목을 앞으로, 없으면 원래 순서(최신순) 그대로 → `slice(0, 8)`
   - 각 항목에 `isMatched` 플래그를 실어 보내면 카드가 "내 관심 계열" 배지 판단에 그대로 쓴다.
2. **`CAT` / `TRACK` / `STATUS` 맵을 프런트에 정의** (예: `src/lib/taxonomy.js`) — 프로토타입 692~716줄을 **키까지 그대로** 재사용. DB enum 값이 곧 이 맵의 키다. 표시명·색상·아이콘·`join` 여부는 전부 프런트 소유(DB에 없음).
3. **카드 렌더** — `pcardHTML()`(815줄) 재현. 표시 필드: `category`(그룹·표시명 태그) / `title` / `org` / `date`(프런트에서 "7월 16일 (목)" 포맷) / `time`(그대로 출력, 파싱 금지 — 자유 텍스트) / `points`(`+NNN P`, amber) / `status`(버튼 라벨·비활성) / `isMatched`(배지).
4. **`popularity`를 화면에 표시하거나 정렬에 쓰지 말 것** (이번 스코프). 학생 랭킹 형태의 UI로 변형 금지.
5. 빈 상태 문구는 프로토타입 849줄 카피 재사용("지금 추천할 새 프로그램이 없어요").
