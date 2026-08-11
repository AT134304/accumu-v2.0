# ADR 0021: 신규 학생 온보딩 튜토리얼 (프로그램 + 셀프 QR 인증 + 가벼운 가이드 트래커)

## 상태

확정 (2026-08-11, 케빈 요청).

## 배경

케빈: *"처음 이 프로그램에 가입했을 때 학생들을 위한 간단한 튜토리얼을 준비하는 거 어때? ... 임시
프로그램을 만들어 이름을 'Accumu 사용법 알아보기', 기간은 무기한... 아무때나 딱 한번 가능한 걸로
만들어줘. 그러고 그 프로그램은 신청하면 QR 인증을 하는데 그 인증이 QR을 보여주기만 하고 설명 후
알아서 인식 완료가 뜨고 아카이브에 기록되는 거 확인하면 포인트 지급되는 과정까지 만들어줘."*

이어서 정확히 12단계짜리 진행 순서를 줬다(프로그램 클릭 → 신청 → 알림 확인 → 마이페이지 → 입장 QR →
자동 인증 안내 → 퇴장 QR → 만족도 평가 → 아카이브 → 아카이브 설명 → 마이페이지 → 지역화폐 설명).

이건 사실 두 가지 요청이 합쳐진 것이었다: (1) 셀프 인증되는 튜토리얼 프로그램 자체, (2) 여러 화면을
오가며 버튼을 짚어주는 가이드. (2)를 실제 화살표/말풍선으로 화면을 짚는 무거운 투어 엔진으로 만들면
이번 세션에서 만든 다른 기능들을 합친 것만큼 커질 수 있어 케빈에게 확인했다 — **"가벼운 단계
트래커 + 눌러야 할 버튼 하이라이트"** 로 확정됐다(완전한 인터랙티브 투어도, 트래커 없이 프로그램만
만드는 것도 아닌 중간).

---

## 결정

### 결정 1 — 튜토리얼 프로그램은 시딩된 시스템 행 하나다, 무기한은 프런트가 판정한다

`programs.is_tutorial boolean` 신규(부분 unique 인덱스로 "앱 전체에 최대 1개"를 강제). 관리자
편집 폼(`ProgramFormModal`의 `FORM_COLUMNS`)에 이 컬럼을 넣지 않아 관리자가 값을 직접 켜거나
끌 수 없다 — 이 마이그레이션이 심은 행 하나가 유일한 소유자다.

- **`created_by = null`.** `AdminProgramsPage`/`AdminHomePage`는 전부 `created_by = 내 id`로
  필터하므로 NULL은 어느 관리자의 목록에도 걸리지 않는다 — 실수로 수정·게시중단되는 사고를
  원천 차단한다("열어둔 문"이 아니라 "존재하지 않는 문").
- **"무기한"은 DB 컬럼이 아니라 프런트 판정이다.** `programs.date`는 not null이라 "날짜 없음"을
  표현할 수 없다 — `is_tutorial=true`인 프로그램은 "지난 날짜" 판정(확정 H-1)에서 항상 제외하고
  "상시 진행"으로 표시한다. 판정 지점 셋: `StudentProgramsPage`(지난 프로그램 그룹핑),
  `JoinModal`(`isPast`), `fetchRecommendedPrograms`의 날짜 `.or()` 조건(안 넣으면 시딩일 다음날부터
  홈 추천에서 조용히 사라지는 버그가 됐다 — 구현 중 발견해 같이 고쳤다).
- **"1인 1회"는 새 제약 없이 기존 `participations` unique(student_id, program_id)로 공짜로
  성립한다.** 취소해도 재신청은 안 된다(취소 자체가 `programs.date <= today` 조건에 걸려 애초에
  안 되지만, 설령 됐어도 이 프로그램은 취소 대상으로 만들지 않는다 — 튜토리얼은 1회성 체험이다).
- **`points=150`(최소값), `category='school'`.** 실제 활동과 동일한 `programs_points_rule`
  체크 제약을 그대로 통과시킨다("이 값만 특별하다"는 예외를 만들지 않는다). 카테고리·계열은
  CLAUDE.md가 금지한 "기타 칸"을 새로 만들지 않기 위해 기존 4종 중 가장 가까운 것을 골랐을 뿐 —
  추천 매칭·필터링에 실질적 의미는 없다.

### 결정 2 — QR 인증은 학생 본인이 검증한다, 관리자 전용 함수는 한 글자도 안 바꾼다

`verify_tutorial_qr(p_token)` 신규 RPC. `verify_participation_qr()`(관리자 전용, ADR 0005)와
CAS 전이·포인트 지급 로직은 완전히 동일하게 복제하되, 자격 검사 두 곳만 다르다:

- `is_admin()` 대신 `참여 건.student_id = auth.uid()` — 학생 본인, 자기 것만.
- `programs.created_by = 호출자` 대신 **`programs.is_tutorial = true`** — 이게 진짜 방어선이다.
  없으면 학생이 실제 프로그램의 QR 토큰을 이 함수에 넣어 관리자 스캔 없이 무단으로 자기 참여를
  완료시키고 포인트를 받아 갈 수 있다(원칙 5 정면 위반). 별도 함수로 완전히 분리한 이유가 이것이다
  — 기존 관리자 전용 함수에 조건문을 얹어 방어선을 느슨하게 만들지 않는다.

프런트(`QrCenterModal`)는 튜토리얼 참여일 때 관리자 스캔을 기다리는 10초 폴링을 아예 돌리지 않고,
QR을 띄운 뒤 `TUTORIAL_AUTO_VERIFY_MS`(1.6초 — 순수 연출용, 판정과 무관) 뒤에
`verify_tutorial_qr()`을 직접 부른다. 그 뒤(포인트 지급 화면·만족도 평가·아카이브 기록)는 전부
**기존 코드를 그대로 재사용한다** — `exitOutcome`/`ReviewForm`/아카이브 조회(`status='completed'`
기준) 어디에도 `is_tutorial` 분기가 없다. "누가 검증을 트리거했는가"만 다르고 그 뒤 결과는 실제
참여와 구분되지 않아야 한다는 게 이 기능의 핵심 설계 목표였다.

### 결정 3 — 가이드 트래커는 하이라이트가 있는 "가벼운" 버전이다

`TutorialContext`(전역 상태, 로그인한 학생별 `localStorage`에 진행 단계 저장) + `TutorialOverlay`
(하단 배너 + 하이라이트 링 + 전역 클릭 감시).

- **`data-tutorial="N"` 속성 하나로 하이라이트와 진행을 동시에 해결한다.** 각 단계의 대상 버튼에
  이 속성을 붙이면, `TutorialOverlay`가 (a) 그 요소를 찾아 링을 그리고 (b) 전역 클릭 리스너가
  그 요소(또는 자손) 클릭을 감지해 `advance()`를 부른다. 클릭을 가로채지 않는다
  (`preventDefault`/`stopPropagation` 없음) — 실제 버튼 동작은 평소와 완전히 같다. 컴포넌트
  대부분은 기존 `onClick`을 한 글자도 안 바꾸고 속성 하나만 추가하면 됐다.
- **근사치라는 것을 코드에 명시했다.** 예: 2단계는 "신청 버튼 클릭"에서 넘어가지, 실제 신청 성공
  여부를 다시 확인하지 않는다. 8단계(만족도 평가)는 예외적으로 명시적 `tutorial.advance()`
  호출을 썼다 — 리뷰폼 자체를 클릭 감시하면 별점만 눌러봐도 다음 단계로 넘어가 버려서, 실제
  "퇴장 인증 완료"(리뷰폼이 뜨는 바로 그 시점)에 코드로 직접 넘긴다.
- **`.tut-ring`/`.tut-banner`는 `document.body`에 포털한다.** `Modal.jsx`가 이미 겪은 문제와
  같다 — `.screen`의 진입 애니메이션에 `transform`이 있어 그 자손에서는 `position:fixed`가
  뷰포트가 아니라 `.screen` 기준이 된다. z-index는 `.overlay`(200)보다 높은 300을 써서 QR
  모달·참여 팝업 안의 버튼도 하이라이트한다.
- **"완료 여부"는 트래커가 아니라 실제 참여로 판단한다.** 홈 화면의 시작 CTA는
  `fetchTutorialProgram()` + `fetchAppliedProgramIds()`로 "신청 이력이 있는가"를 직접 확인한다
  — `localStorage`의 진행 상태(몇 단계인지)와 "완료했는가"는 다른 질문이라 섞지 않았다.

12단계와 정확한 대상은 코드(`TutorialContext.TUTORIAL_STEPS`)를 참고. 마이페이지 링크는 4·11
두 단계에서 재사용되고, 아카이브 도착(10단계)·마이페이지 재도착(12단계)은 별도 하이라이트 없이
배너의 "다음"/"완료" 버튼으로 넘긴다(짚을 특정 버튼이 없는 "설명만" 단계라서다).

---

## 구현

- `supabase/migrations/20260811260000_add_tutorial_program.sql` — `is_tutorial` 컬럼 + 유일성
  인덱스 + 시드 + `verify_tutorial_qr()`. 결정 1·2.
- `src/lib/participationService.js` — `verifyTutorialQr()`, `PROGRAM_FIELDS`에 `is_tutorial` 추가.
- `src/lib/programService.js` — `CARD_FIELDS`에 `is_tutorial` 추가, `fetchTutorialProgram()` 신규,
  `fetchRecommendedPrograms()`의 날짜 `.or()`에 `is_tutorial.eq.true` 추가(발견한 버그 수정).
- `src/components/student/{ProgramCard,JoinModal}.jsx`, `src/pages/StudentProgramsPage.jsx` —
  "상시 진행" 표시, `isPast` 예외, 튜토리얼 전용 안내문. 결정 1.
- `src/components/student/QrCenterModal.jsx` — 셀프 검증 흐름(폴링 대신 타임아웃 →
  `verifyTutorialQr`), 튜토리얼 전용 안내문/UI 축약. 결정 2.
- `src/context/TutorialContext.jsx`(신규) — 상태·단계 정의. 결정 3.
- `src/components/student/TutorialOverlay.jsx`(신규), `src/styles/Tutorial.css`(신규) — 배너·링·
  전역 클릭 감시. 결정 3.
- `src/routes/StudentLayout.jsx` — `TutorialProvider`로 감싼다(학생 전용, 관리자 화면엔 없음).
- `src/components/student/StudentShell.jsx` — 프로그램/알림/아카이브/마이페이지에 `data-tutorial`.
- `src/pages/StudentHomePage.jsx` — 시작 CTA(`tutorial.start()`), CSS import.
- `src/pages/StudentMyPage.jsx` — "QR 확인" 버튼에 `data-tutorial-pre="5"`(버그 수정).

---

## 절대 원칙 체크

- **원칙 1** (게임화 금지): 하이라이트·배너는 화살표 게임이나 보상 연출이 아니라 "다음에 뭘 누를지"
  안내다. 완료 축하 이모지·컨페티·카운트업 없음(기존 규율 그대로 재사용했을 뿐 새로 만들지 않았다).
- **원칙 5** (QR 2회 인증): 실제 프로그램의 QR 검증 경로(`verify_participation_qr`, 관리자 전용)는
  이 ADR로 단 한 글자도 바뀌지 않았다. 셀프 검증은 `is_tutorial=true`인 시스템 프로그램 하나에만
  열린 별도 함수다.
- **원칙 6** (관리자 기능 한정): 영향 없음. 이 기능은 학생 화면 전용이고 관리자가 새로 할 수 있게
  된 동작이 0개다(오히려 이 프로그램은 관리자 목록에 아예 안 뜬다).

## 알려진 사항

- **트래커는 상태 기계가 아니라 근사치다.** 새로고침·뒤로가기·여러 탭 동시 사용 같은 비정상 경로에서
  단계가 실제 진행과 어긋날 수 있다(예: 2단계에서 신청이 실패해도 클릭만으로 3단계로 넘어간다).
  틀어져도 배너의 × 버튼으로 언제든 트래커를 끌 수 있고, 튜토리얼 프로그램 자체의 진행(신청→QR→
  완료)은 트래커와 무관하게 정확하다 — 트래커가 어긋나도 실제 데이터가 어긋나지는 않는다.
- **[2026-08-11 수정] 두 번 클릭해야 하는 단계는 `data-tutorial-pre`로 중간 버튼도 하이라이트한다.**
  "QR 확인 버튼을 누르고 입장 QR을 열어보세요"(5단계)처럼 실제 진행 목표(입장 QR 버튼)가 아직
  DOM에 없는 동안에는, 진행 트리거가 아닌 하이라이트 전용 속성(`data-tutorial-pre`)이 중간
  버튼(QR 확인 버튼, 2단계는 프로그램 카드)을 대신 밝힌다 — 클릭해도 진행되지 않고, 진짜 목표가
  나타나면 링이 자연히 그쪽으로 넘어간다. 최초 배포에서는 이 속성이 빠져 있어 "카드/버튼 주변에
  하이라이트가 없다"는 피드백을 받고 추가했다(`TutorialOverlay.jsx` 참고).
- **[2026-08-11 수정] 8단계(만족도 평가) 이후 진행이 멈추는 버그.** `ReviewForm`의 `onSaved`/
  `onSkip` 콜백에 `tutorial.advance()` 호출이 빠져 있어 리뷰를 저장하거나 건너뛰어도 9단계로
  넘어가지 않았다 — 실제 사용 중 발견해 두 콜백 모두에 추가했다.
- **동시 다발 참여를 상정하지 않는다.** 튜토리얼은 학생 1명이 순서대로 진행한다는 전제다 — 여러
  학생이 정확히 같은 순간에 신청해도 문제없다(참여 행은 학생별로 독립적이다), 트래커만 각자
  브라우저의 `localStorage`에 따로 있어 서로 간섭하지 않는다.
