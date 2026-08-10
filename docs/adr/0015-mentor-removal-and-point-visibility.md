# ADR 0015: 담당 학생 해제 + 관리자의 담당 학생 포인트 열람 (원칙 4·6 개정)

## 상태

확정 (2026-08-10, 케빈 요청).

## 배경

케빈: *"관리자 페이지에서 학생 확인할 수 있잖아. 그때 학생이 초대 코드 입력하면 추가되는데 그 반대로
학생 추방 기능도 만들어줘. 그러고 관리자가 학생이 모은 포인트 확인 할 수 있게 해줘."*

두 요청 모두 이 프로젝트가 지금까지 명시적으로 막아 온 것이었다:

- **원칙 6** (CLAUDE.md 2장): "관리자 기능은 아래 3가지로 한정" — 프로그램 관리·담당 학생 아카이브
  조회·QR 스캔. `mentor_students`는 "insert/update/delete 정책 0개 — 매핑 변경 UI 없음"
  (ADR 0005 결정 7-2)이 명시적 결정이었다.
- **원칙 4**: "포트폴리오가 포인트보다 먼저 보여야 함." `archiveService.js`의 `MENTORED_STUDENT_FIELDS`
  주석은 "★ points_balance / points_total / currency_balance를 넣지 말 것"이라고 굵게 못박고 있었다
  ("컬럼을 싣는 순간 화면 어딘가에 '이왕 온 김에' 표시하고 싶어지고, 그건 관리자 화면이 '누가 얼마
  벌었나'를 읽는 순간이다").

케빈이 두 결정을 뒤집기로 확정했다 — 이 ADR은 그 반영이다. >>> 이후 에이전트가 이 결정을 "실수로
원칙을 어긴 코드"로 오인해 되돌리지 않도록, 뒤집힌 원칙과 그 이유를 CLAUDE.md 2장에도 함께 반영했다.

---

## 결정

### 결정 1 — 담당 해제는 관리자 기능의 4번째가 된다

원칙 6을 "3가지 한정"에서 "4가지 한정"으로 개정한다: 프로그램 관리, 담당 학생 아카이브 조회(포인트
열람 포함), QR 스캔, **담당 해제**.

- 경계는 `mentor_students_delete_own_as_admin`(admin_id = auth.uid()) 하나다. 다른 관리자의 매핑,
  학생 스스로의 매핑에는 도달하지 못한다.
- **지워지는 것은 관계 1행뿐이다.** 학생의 `profiles`(포인트 포함)·`participations`·
  `point_transactions`는 `mentor_students`를 참조하지 않는다 — "추방"은 그 관리자의 시야에서
  빠지는 것이지 학생 기록 삭제가 아니다.
- **UI는 확인 모달을 거친다** — "내리기"(admin-programs 확정 J)와 같은 2단계 규율. 즉시 삭제 버튼을
  만들지 않는다.
- 초대코드 생성·재발급·회수 UI는 **여전히 막혀 있다.** 그건 관리자가 담당을 스스로 **늘리는** 도구이고,
  이번에 연 것은 **줄이는** 쪽 하나뿐이다. 두 방향을 같은 결정으로 묶지 말 것.

### 결정 2 — "이미 연동됨"의 정의를 account_type에서 실제 매핑 여부로 바꾼다

결정 1만으로는 "추방"이 영구 고아 상태를 만든다: `profiles.account_type`은 한 번 `'school'`이 되면
되돌아가지 않는 컬럼이고(ADR 0008 결정 5), 기존 `link_school_account()`는 `account_type = 'school'`
이면 무조건 `already_linked`를 반환했다. 담당이 해제된 학생은 `account_type`이 여전히 `'school'`이라
어떤 초대코드를 넣어도 다시는 연동될 수 없었다.

`link_school_account()`를 재정의해 판정 기준을 "`mentor_students`에 내 행이 있는가"로 바꿨다.
`account_type`이 한 번 school이 되면 안 바뀐다는 결정 자체는 그대로다(UPDATE SET 목록도 안 바꿨다) —
바뀐 것은 "이미 연동됨"이 가리키는 대상이 "역사"에서 "현재 상태"로 바뀐 것뿐이다. 정상적으로 담당이
있는 학생은 동작이 전혀 달라지지 않는다.

**되돌릴 수 있는 동작이 됐다.** 관리자가 실수로 해제해도 학생이 초대코드(같은 관리자든 다른
관리자든)를 다시 입력하면 복구된다.

### 결정 3 — 포인트는 "학생 1명" 화면에서만 연다, "5명 목록" 화면은 그대로 막는다

RLS는 이미 열려 있었다 — `profiles_select_mentored_students_as_admin`(20260723120000)은 담당 학생
행의 **모든 컬럼**을 허용한다. 지금까지 안 보여준 것은 권한 경계가 아니라
`archiveService.js`의 select 목록(프런트 선택)이었다.

- `MENTORED_STUDENT_DETAIL_FIELDS`(신규, `MENTORED_STUDENT_FIELDS` + `points_balance`/
  `points_total`)를 만들어 **`fetchMentoredStudent()`(1명 상세)에서만** 쓴다.
- **`fetchMentoredStudents()`(5명 목록, `AdminMyPage`)는 여전히 `MENTORED_STUDENT_FIELDS`만 쓴다.**
  결정 B(admin-students 스펙)가 이 목록에 숫자를 넣지 말라고 한 이유 — "5명이 나란히 놓인 목록에
  숫자가 붙는 순간 비교표다" — 는 이번 개정과 무관하게 유효하다. `AdminStudentArchivePage.jsx`의
  `.adm-row.student`에 포인트를 붙이지 말 것.
- `currency_balance`(지역화폐)는 이번에 함께 열지 않는다. 요청받은 것은 포인트뿐이고, 지역화폐까지
  넓히는 것은 이 ADR의 범위가 아니다 — 필요해지면 별도로 확인받을 것.
- 활동 **행 단위** 지급액(`amountByParticipationId`)은 여전히 관리자 화면에 넘기지 않는다. "이 활동으로
  얼마 벌었나"는 활동 목록을 포인트 나열로 바꾸는 것이라 결정 3의 범위 밖이다 — 헤더의 잔액/누적 총합
  한 줄까지만.

---

## 구현

- `supabase/migrations/20260810120000_add_mentor_removal_and_point_visibility.sql`
  - `mentor_students_delete_own_as_admin` — DELETE 정책 1개.
  - `link_school_account()` 재정의 — 결정 2.
- `src/lib/archiveService.js`
  - `MENTORED_STUDENT_DETAIL_FIELDS` 신규(목록 상수와 분리 — 결정 3).
  - `fetchMentoredStudent()`가 새 상수를 쓰도록 변경.
  - `removeMentee(studentId)` 신규 — `mentor_students` delete, 0행 영향 시 에러(RLS가 막았거나 이미
    해제됨).
- `src/pages/AdminStudentArchivePage.jsx`
  - "담당 해제" 버튼(`.adm-removebtn`) + 확인 모달(`RemoveMenteeConfirm`, `UnpublishConfirm`과 같은
    패턴). 성공 시 `/admin/mypage`로 이동.
  - 학생 헤더에 포인트 한 줄(`.adm-studenthead .pts`) — 잔액 + 누적, amber, 카드/타일이 아니라 한 줄.
- `src/pages/AdminMyPage.jsx` — **변경 없음.** 목록에 숫자를 추가하지 않는다(결정 3).
- `src/styles/AdminShell.css` — `.adm-removebtn`(rose 톤), `.adm-studenthead .pts` 추가. 기존
  "포인트가 들어갈 자리가 없다" 주석 갱신.
- `CLAUDE.md` — 원칙 4·6, 4장(역할 구조)·5장(데이터 모델)·10장(관리자 화면) 문구 갱신.

---

## 절대 원칙 체크

- **원칙 1** (게임화 금지): 담당 학생 "목록"에는 여전히 숫자가 없다. 포인트가 보이는 유일한 자리(1명
  상세)에도 비교·순위·진행률을 만들지 않는다 — 그 학생 한 명의 잔액/누적 사실 두 개뿐이다.
- **원칙 4** (포트폴리오 우선): 예외를 명시적으로 남겼다(개정된 원칙 4 문구 참고) — 기본값은 여전히
  "포인트보다 활동"이고, 이번 예외는 관리자의 1명 상세 화면 헤더 한 줄로 범위가 좁다.
- **원칙 6** (관리자 기능 한정): 4가지로 개정했다. 5번째(초대코드 관리)는 여전히 닫혀 있다.

## 알려진 사항

- **재연동은 무기명이다.** 해제된 학생이 다시 연동될 관리자는 그 학생이 입력하는 초대코드가 정한다 —
  반드시 원래 관리자로 돌아가는 것이 아니다. 데모 규모(관리자 1명)에서는 체감되지 않지만, 관리자가
  여럿이면 "실수로 해제 → 학생이 다른 관리자 코드를 넣어 이동"이 가능하다는 뜻이다. 이번 스코프에서는
  수용한다.
- **감사 로그가 없다.** 누가 언제 담당을 해제했는지 별도로 남기지 않는다(데모 규모, 다른 관리자 쓰기
  동작들과 같은 수준).
