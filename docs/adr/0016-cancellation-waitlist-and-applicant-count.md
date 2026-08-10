# ADR 0016: 신청 취소 + 정원 초과 시 자동 대기열 + 신청자 수 공개

## 상태

확정 (2026-08-10, 케빈 요청).

## 배경

케빈: *"신청 취소 버튼을 만드는데 이제 프로그램 시작 전날까지만 가능하게 기능 추가하고 정원이 차면
자동으로 신청 아이콘이 대기로 바뀌게 해줘. 신청자 수를 보이게 해. 그런데 초대코드 유출을 막을 방법은
앞의 문제 해결하고 나서 생각해보자."*

세 가지 요청 모두 ADR 0006(프로그램 정원 게이트)이 명시적으로 막아 온 것이었고, 동시에 ADR 0006
스스로가 "재검토 시점"으로 예고했던 바로 그 상황이다:

- **결정 1-3**: "재검토 시점: 신청 취소나 대기열이 생기면 신청 경로가 'insert 1개'가 아니게 되고
  원자성 요구가 생긴다. 그때는 RPC 이관을 다시 검토한다."
- **결정 2 "수용"**: "신청만 하고 안 온 학생이 자리를 막는다... 취소가 생기면 이 규칙을 재검토한다."
- **결정 6**: "밖으로 나가는 것은 '찼다'라는 1비트뿐" — 신청자 수(정확한 카운트)는 절대 노출하지 않는다.

케빈이 그 시점을 확정했다 — 이 ADR은 그 반영이다. 마지막 문장("초대코드 유출 방지")은 이번 스코프가
아니다 — 명시적으로 다음으로 미뤄졌다.

>>> 이후 에이전트가 이 결정을 "실수로 ADR 0006을 어긴 코드"로 오인해 되돌리지 않도록, 무엇이 왜
뒤집혔는지 여기 남긴다. ADR 0006 자체는 폐기되지 않는다 — for update 잠금·status 무관 카운트·
"신청 가능 여부는 프런트 표시 + DB 경계 2층" 같은 구조는 그대로 유효하고, 이 ADR이 손댄 것은 결정
2·6과 "거부"라는 결과값 하나뿐이다.

---

## 결정

### 결정 1 — 정원이 차면 거부 대신 대기열(`waitlisted`)

`participation_status` enum에 `waitlisted`를 추가한다(단독 마이그레이션 `20260810160000` — enum 값
추가는 55P04 제약 때문에 그 값을 쓰는 코드와 같은 트랜잭션에 있으면 안 된다. 규율은
`20260808100000`과 동일).

`participations_capacity_guard()`(ADR 0006 결정 5)를 재정의한다. 정원이 찼을 때의 동작만 바뀐다:

| | ADR 0006 (이전) | ADR 0016 (이후) |
|---|---|---|
| 정원 찼을 때 | `raise exception` (P0001, hint=`capacity_full`) → insert 실패 | `new.status := 'waitlisted'` → insert 성공 |
| 학생이 받는 결과 | 신청 자체가 거부됨(`applyToProgram` → `'full'`) | 신청은 항상 성공, 결과가 `'created'`/`'waitlisted'`로 갈림 |
| 잠금·카운트 방식 | `for update` 잠금, status 무관 카운트(F-2) | **그대로** |
| NULL capacity(무제한) | 항상 통과 | **그대로** |

`participations_insert_own`의 with check도 `status = 'applied'`에서 `status in ('applied',
'waitlisted')`로 넓힌다 — 학생이 스스로 대기열 값을 고르는 게 아니라(컬럼 단위 grant가 여전히
`student_id`/`program_id`뿐), 트리거가 정한 결과를 통과시키기 위한 대칭 확장이다. 다른 8개 with check
절은 SQL 한 글자도 안 바뀐다.

### 결정 2 — 신청 취소는 RPC 하나로, RLS 정책은 열지 않는다

`cancel_my_participation(p_participation_id uuid) returns jsonb` 신규.

- **왜 RPC인가 (ADR 0006 결정 1-3이 예고한 지점)**: 취소가 "내 행을 지운다"에서 끝나지 않는다 —
  `applied`였던 자리가 비면 가장 먼저 대기한 `waitlisted` 1명을 `applied`로 승격해야 한다. 두 행에
  걸친 원자적 연산이라 RLS delete 정책 하나로는 표현할 수 없다.
- **권한 경계**: `student_id = auth.uid()`인 본인 행만, `for update`로 잠근다. delete/update RLS
  정책은 여전히 0개 — 이 함수가 유일한 경로다.
- **취소 가능 조건**: `status in ('applied', 'waitlisted')`만. `entered`/`completed`는
  `already_started`로 거부(이미 참여가 시작됨).
- **날짜 경계 — "시작 전날까지"**: `today_kst() >= programs.date`면 `too_late`. 당일부터는 취소가
  아니라 참여 포기가 되므로 막는다(기간제도 시작일 기준 — 진행 중 취소는 이번 스코프가 아니다).
  `today_kst()`는 이 ADR에서 새로 뺀 공유 헬퍼로, `sync_my_notices()`가 인라인으로 하던 KST 오늘
  계산을 대체한다(두 함수가 다른 타임존 계산을 쓰는 드리프트 방지).
- **승격 대상**: 그 프로그램의 `waitlisted` 중 `created_at`이 가장 이른 1명 — 선착순. `for update`로
  잠가 동시 취소 2건이 같은 대기자를 중복 승격시키지 않는다(CAS: `update ... where status =
  'waitlisted'` + `get diagnostics`로 실제 갱신 여부 확인).
- **승격이 필요 없는 경우**: 취소한 행 자체가 `waitlisted`였다면 애초에 자리가 없었으므로 승격을
  시도하지 않는다.
- **프런트는 UX일 뿐 경계가 아니다**: 날짜 판정을 클라이언트에서 막아도 새로고침·다른 탭으로
  우회되므로, 진짜 경계는 함수 안 날짜 비교다.

### 결정 3 — 신청자 수는 "몇 명"까지만 연다, "누가"는 계속 닫혀 있다

`program_applicant_counts() returns table(program_id uuid, applicant_count integer)` 신규.
`applied`+`entered`+`completed`만 센다(`waitlisted` 제외 — "확정된 자리 수"라는 뜻을 지키려면 대기
인원은 빼야 정원과 비교했을 때 숫자가 맞는다). `security definer`로 전체를 세고(invoker면
`participations_select_own`에 걸려 본인 것만 보임), `authenticated`(학생·관리자 공통) 전체에 grant한다.

- **연 것**: 정확한 카운트. 정원과 나란히 "N명 신청 · 정원 M명"처럼 사실 두 개를 병기한다 — 비율·
  퍼센트·게이지가 아니다(원칙 1 — "몇 명"은 순위가 아니라 그 프로그램 하나의 사실).
- **계속 닫혀 있는 것**: 신청자 명단·학번·이름(ADR 0005 결정 7-2(d)는 이 ADR이 건드리는 범위가
  아니다 — "몇 명"과 "누가"는 다른 결정이다). `waitlisted` 인원 수도 별도로 노출하지 않는다(필요해지면
  그때 확정).
- **학생 화면**: `JoinModal`의 infogrid에 "신청 현황" 칸으로, `ProgramCard`에도 "N명 신청" 메타 줄로
  보여준다.
- **관리자 화면 — 별도 확정**: 애초 계획은 학생 화면 한정이었으나, 작업 중 "관리자의 '프로그램 관리'
  목록에도 보여줄까"를 케빈에게 물어 **"보여준다"로 확정**했다(2026-08-10). `AdminProgramsPage`의
  각 행 메타 줄에 "신청 N명 · 정원 M명"을 추가한다. 관리자 홈(`fetchAdminHomePrograms`)은 범위 밖으로
  **의도적으로 남긴다** — 넓히려면 그때 다시 확인받을 것.
  >>> 이 예외로 `AdminProgramsPage.jsx`/`programService.js`의 "참여자 수를 조회하지 않는다" 가드
  주석이 부분적으로 갱신됐다. 남은 가드(신청자 명단·출석률·랭킹)는 그대로 유효하다.

### 결정 4 — QR 발급도 `waitlisted`를 막아야 한다 (구현 중 발견한 실제 보안 구멍)

`waitlisted`를 프런트 목록(`QrCenterModal`)에서 빼는 것과는 별개로, 두 QR 발급 RPC를 점검했다:

- `issue_participation_qr`(단일 일자)는 원래부터 안전했다 — `p_type = 'entry' and status <> 'applied'`
  검사가 있어 `waitlisted`는 자동으로 `wrong_order`로 거부된다.
- `issue_attendance_qr`(기간제)는 **안전하지 않았다.** `status = 'completed'`만 걸렀을 뿐, 그 외
  상태는 전부 통과해 `session_dates`/`attendance_sessions`만 봤다 — 대기 중인 학생이 오늘이 진행일인
  기간제 프로그램에서 `issue_attendance_qr`을 **직접 호출**하면(자기 `participation_id`는 당연히
  알 수 있다) `attendance_sessions` 행을 만들고 진짜 입장 QR을 받을 수 있었다. 프런트 필터는 UI를
  깨끗하게 할 뿐 권한 경계가 아니므로(다른 모든 RPC와 같은 원칙 — ADR 0005), 이건 UX 문제가 아니라
  **정원 게이트를 완전히 우회하는 구멍**이었다.
  - **고침**: `status = 'completed'` 체크 바로 뒤에 `status <> 'applied' and status <> 'entered'`면
    `wrong_order`로 거부하는 줄을 추가했다. 그 아래 로직(session_dates·attendance_sessions 검사,
    토큰 발급)은 한 글자도 안 바뀐다.
  - 이 수정은 `20260810180000` 마이그레이션에 함께 포함했다 — 아직 적용 전이었기 때문에 별도
    마이그레이션 없이 같은 파일에서 `create or replace`로 패치했다.

### 결정 5 — 알림도 `waitlisted`를 확정된 참여로 착각하면 안 된다

`sync_my_notices()`(ADR 0013 → 기간제 대응 `20260810140000`)를 다시 손봤다. 기간제 (3-기간제)
upcoming 조건이 `pa.status <> 'completed'`였는데, 이건 `waitlisted`도 통과시켜 대기 중인 학생에게
"내일 참여 예정이에요"를 잘못 띄웠다(자리가 없는데 있다고 말하는 셈). `pa.status in ('applied',
'entered')`로 좁혔다. 다른 세 조건(stale/upcoming_admin/단일 일자 upcoming/exit_due)은 원래부터
`waitlisted`와 무관해 손대지 않았다.

---

## 구현

- `supabase/migrations/20260810160000_add_waitlisted_participation_status.sql` — enum 값 추가(단독
  실행 필수, 55P04).
- `supabase/migrations/20260810180000_add_cancellation_and_waitlist.sql`
  1. `today_kst()` 신규 — KST 오늘 공유 헬퍼.
  2. `participations_capacity_guard()` 재정의 — 결정 1.
  3. `participations_insert_own` 재정의 — 결정 1.
  4. `cancel_my_participation(uuid)` 신규 — 결정 2.
  5. `program_applicant_counts()` 신규 — 결정 3.
  6. `sync_my_notices()` 재정의 — 결정 5.
  7. `issue_attendance_qr(uuid, text)` 재정의 — 결정 4.
- `src/lib/programService.js`
  - `applyToProgram()` — `.select('status')`로 실제 결과를 읽어 `'created'|'waitlisted'|'duplicate'`
    반환. `'full'`/`capacity_full` 분기 삭제(더 이상 발생하지 않는다).
  - `cancelMyParticipation(participationId)` / `fetchApplicantCounts()` 신규.
  - `fetchMyParticipationsByProgram()` 신규 — `program_id -> {id, status}` Map(기존
    `fetchAppliedProgramIds()`의 Set을 대체 — 대기중/신청됨 구분과 취소 버튼용 id가 필요해졌다).
  - `CARD_FIELDS`/`ADMIN_MANAGE_FIELDS`에 `capacity` 노출(결정 3).
- `src/components/student/JoinModal.jsx` — CTA에 `대기 신청하기`/`대기 중이에요` 상태 추가, "신청
  취소하기" 보조 버튼(`canCancel` 조건), infogrid에 "신청 현황" 칸.
- `src/components/student/ProgramCard.jsx` — `participation`/`applicantCount` prop으로 교체(기존
  `joined`/`full` bool 제거), "대기중"/"대기 신청" 라벨, 카드에 "N명 신청" 메타 줄.
- `src/pages/StudentProgramsPage.jsx` — `appliedIds`/`fullIds` Set 2개를
  `participationByProgram`/`applicantCounts` Map 2개로 교체. 신청/취소 후 낙관적 패치 대신 두 Map을
  재조회(`refreshParticipation`) — waitlisted로 등록될지, 취소가 누군가를 승격시킬지는 서버만 안다.
- `src/components/student/QrCenterModal.jsx` — 목록 필터에 `status !== 'waitlisted'` 추가(결정 4의
  UX 짝 — 서버가 막아도 목록에 뜨는 건 별개 문제였다).
- `src/components/student/CalendarPopup.jsx` — `kindOf()`에 `waitlisted` -> `'wait'` 우선 분기,
  배지 4번째 종류("대기중").
- `src/pages/AdminProgramsPage.jsx` — 목록 행 메타 줄에 "신청 N명 · 정원 M명"(결정 3의 관리자 확장).
- `src/styles/StudentShell.css` — `.join-cancel`(취소 버튼), `.join-full` → `.join-hint`로 이름 확장
  (마감이 더 이상 거부가 아니므로).
- `src/styles/Notifications.css` — `.cb.wait` 배지 톤.
- `docs/specs/student-programs.md` — CTA 표에 개정 각주, G(신청 취소) 결정 뒤집기 각주, 원칙 1 체크
  항목 갱신.

CLAUDE.md는 이번 ADR로 바뀌지 않는다 — 뒤집힌 것은 ADR 0006의 결정(2·6)이지 CLAUDE.md의 절대 원칙
1~6이 아니다(ADR 0015와 다른 점 — 그때는 원칙 4·6 문구 자체를 고쳤다).

---

## 절대 원칙 체크

- **원칙 1** (게임화 금지): 신청자 수는 순위·경쟁이 아니라 그 프로그램 하나의 사실 두 개(신청 N명,
  정원 M명)다. 게이지·퍼센트·"마감 임박"·"TOP 인기"는 어디에도 없다. 학생 단위 집계·랭킹으로 파생하지
  않는다.
- **원칙 4** (포트폴리오 우선): 신청자 수는 amber(포인트 색)가 아니라 중립 톤이다. 포인트 시각 위계에
  영향 없음.
- **원칙 6** (관리자 기능 한정): "프로그램 관리"에 신청자 수를 더한 것은 새 기능이 아니라 기존 기능
  (프로그램 관리)의 표시 확장이다 — 관리자가 새로 할 수 있게 된 **동작**은 0개(ADR 0013이 알림·캘린더를
  4종 밖으로 세지 않은 것과 같은 논리).

## 알려진 사항

- **승격 알림이 없다.** `waitlisted`에서 `applied`로 승격된 학생에게 별도 알림 타입을 만들지 않았다.
  다음에 화면을 열면(프로그램 선택 화면 재조회, 또는 QR 센터에 항목이 나타남) 상태가 바뀐 것을 알게
  된다. 실시간으로 알리려면 `notifications` 타입을 하나 더 늘려야 하는데, 이번 요청 범위가 아니라
  넣지 않았다 — 필요해지면 별도로 확인받을 것.
- **재신청 시 대기열 순번을 보여주지 않는다.** "대기 3번째" 같은 순번 표시는 만들지 않았다(원칙 1과도
  맞물린다 — 순번은 순위처럼 읽힐 수 있다). "대기 중" 사실 하나만 보여준다.
- **초대코드 유출 방지는 명시적으로 다음으로 미뤄졌다.** 케빈이 이번 요청 끝에 직접 그렇게 말했다 —
  이 ADR의 범위가 아니다.
- **관리자 홈은 신청자 수를 보여주지 않는다.** "프로그램 관리" 목록에만 넣기로 확정했다(결정 3) —
  범위를 넓히면 그때 다시 확인받을 것.
