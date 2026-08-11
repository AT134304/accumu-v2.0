# ADR 0018: 사용성 개선 라운드 — 알림 정밀화 + 안내 문구 + 대기 순번

## 상태

확정 (2026-08-11, 케빈 요청).

## 배경

케빈이 "사용자가 느낄 불편함"을 정리해 달라고 해서 목록을 만들었고(9개 신규 항목), 그중 8개
(1/2/4/6/7/9/11/12 — 번호는 그 목록 기준)를 이번에 해결하기로 확정했다. 나머지 항목 중 3/8/10번은
의도된 동작으로 확인해 스코프에서 뺐고, 5번(포인트 정산)은 다른 요청과 묶어 나중에 다시 보기로
했다. 14번(비밀번호 재설정)은 원칙 6을 다시 여는 별도 결정이라 ADR 0019로 분리했다.

이 ADR이 다루는 8개는 전부 **기존 결정을 뒤집지 않는다** — 새 사실을 더 정밀하게 보여주거나
(순번, 진행일마다 알림), 이미 존재하는 기능의 안내를 더할 뿐이다(QR 위치, 정원 힌트). 그래서
CLAUDE.md의 절대 원칙 1~6은 이 ADR로 바뀌지 않는다 — ADR 0015·0019(원칙 6)나 ADR 0016(원칙 1의
신청자 수 예외)과는 성격이 다르다.

케빈이 우선순위를 직접 정하라고 위임했다. 프론트만 건드리는 것 → 마이그레이션 하나로 끝나는 것 →
스키마·트리거가 얽히는 것 순서로 진행했다(아래 "구현" 목록도 그 순서 그대로다).

---

## 결정

### 결정 1 — 정원 필드 안내는 placeholder가 아니라 hint여야 한다 (문제 12)

`ProgramFormModal`의 정원(capacity) 입력은 `placeholder="비워두면 제한 없음"`이었는데, placeholder는
값이 있으면(수정 화면처럼 이미 숫자가 채워진 경우) 렌더되지 않는다 — "지우면 무제한이 된다"는 사실을
정작 그 판단이 필요한 수정 화면에서는 절대 볼 수 없었다. `Field`가 이미 갖고 있던 `hint` prop(포인트
필드가 쓰는 것과 같은 자리)으로 옮겨 값 유무와 무관하게 항상 보이게 했다.

### 결정 2 — QR 만료 5분 전부터 경고 톤 (문제 4)

30분 카운트다운이 0초에 갑자기 회색→빨강으로 바뀌면, 늦게 온 학생은 스캔대 앞에서야 만료를 안다.
마지막 5분은 amber 톤으로 미리 바꾼다. 판정 주체(서버의 `*_token_expires_at`)는 그대로다 — 이건
표시 타이밍만 앞당긴 것이지 새로운 판정 로직이 아니다.

### 결정 3 — 단일 일자 프로그램에도 신청 후 QR 안내를 붙인다 (문제 1)

확정 F-1("QR을 약속하는 카피 금지")은 QR 기능 자체가 없던 시점의 결정이었다. 지금은 QR이 실제로
있으므로(CLAUDE.md 6장) 안내가 더 이상 거짓 약속이 아니다. `JoinModal`의 infogrid 아래에 기간제와
대칭되는 안내문을 추가했고, 신청 성공 토스트에도 "마이페이지에서 QR을 확인하세요"를 짧게 덧붙였다.
**CTA 버튼 라벨 자체는 그대로 QR을 언급하지 않는다** — 그 자리는 "지금 이 클릭이 뭘 하는가"만 말하는
자리라 안내문과 섞으면 라벨이 길어진다는 순수 레이아웃상의 이유다.

### 결정 4 — 팝업을 열 때마다 신청자 수·참여 상태를 조용히 다시 읽는다 (문제 9)

신청자 수(ADR 0016)는 페이지 로드 시점 스냅샷이라 오래 열어 두면 stale해진다. 매초 폴링하는 대신
"학생이 가장 관심 있게 보는 순간"(팝업을 여는 순간)에만 다시 읽는다 — 팝업 자체는 즉시 뜨고 숫자만
몇백ms 뒤에 최신화된다. 실패해도 무시한다(이미 조용히 실패를 삼키는 fetch 함수들이라 별도 처리가
필요 없다).

### 결정 5 — 대기 순번을 공개한다 (문제 7, ADR 0006/0016의 재검토)

ADR 0016 때는 "순번은 순위처럼 읽힐 수 있다"며 의도적으로 숨겼다. 이번에 명시적으로 뒤집혔다 — 신청자
수를 연 것과 같은 논리다: "내가 몇 번째인가"는 다른 학생과 겨루는 순위가 아니라 내 상황에 대한 사실
하나다. `my_waitlist_positions()` RPC 신규(`program_applicant_counts()`와 같은 패턴 — security
definer로 세기만 하고 다른 학생의 행 내용은 반환하지 않는다). 순번 계산 기준(`created_at asc`)은
`cancel_my_participation()`의 승격 선정 기준과 반드시 같아야 "3번째"가 실제 승격 순서와 일치한다.

### 결정 6 — 상태형 알림에 `session_date`를 더해 기간제 진행일마다 뜨게 한다 (문제 2)

`notifications_once_per_program_idx`가 (recipient, program, type)으로만 좁혀져 있어서, 기간제
프로그램은 진행일이 몇 개든 upcoming/upcoming_admin/exit_due가 프로그램 전체에서 딱 1번만 떴다
(20260808140000/20260810140000이 이미 "알려진 열화"로 문서화했던 그 제약). `session_date`(nullable)
컬럼을 더하고 unique 인덱스를 `coalesce(session_date, sentinel)`까지 4열로 넓혔다 — `stale`처럼
날짜가 없는 타입은 NULL이 sentinel로 수렴해 예전처럼 프로그램당 1번, `upcoming`/`upcoming_admin`/
`exit_due`는 그 알림이 가리키는 구체적 날짜가 다르면 각각 뜬다.

### 결정 7 — 대기 승격을 알린다 (문제 6)

`cancel_my_participation()`이 waitlisted 학생을 applied로 승격시켜도 알림이 없었다 — 다음에 화면을
직접 열어야만 알 수 있었다. `notifications_on_participation()` 트리거는 UPDATE에서 entry_at/exit_at
변화만 보므로 status만 바뀌는 승격은 그 어떤 조건에도 안 걸린다 — 그래서 승격을 발생시키는 함수
자신이 `notify_user()`를 직접 호출하게 했다(`notification_type`에 `promoted` 추가, 55P04라 단독
실행 파일에 한 줄만 더함).

### 결정 8 — 프로그램 일정이 바뀌면 신청자에게 알린다 (문제 11)

프로그램 수정은 RPC가 아니라 평범한 `update()`(RLS `programs_update_own_as_admin`)라 가로챌 단일
진입점이 없다 — `notifications_on_program_published()`(게시 순간을 잡는 트리거)와 같은 자리에
"일정이 바뀌는 순간"을 잡는 트리거를 하나 더 붙였다. `date`/`end_date`/`time`/`session_dates` 중
하나라도 달라지고 게시 중이면, 그 프로그램에 신청·대기 중인(applied/entered/waitlisted) 학생에게만
알린다(전교생이 아니라 참여자 수만큼 — 게시 알림과 다른 팬아웃 규모). `notification_type`에
`rescheduled` 추가.

---

## 구현

- `src/components/admin/ProgramFormModal.jsx` — 결정 1.
- `src/components/student/QrCenterModal.jsx`, `src/styles/Qr.css` — 결정 2.
- `src/components/student/JoinModal.jsx`, `src/pages/StudentProgramsPage.jsx` — 결정 3.
- `src/pages/StudentProgramsPage.jsx`(`handleOpenProgram`) — 결정 4.
- `supabase/migrations/20260811140000_add_waitlist_position.sql`(`my_waitlist_positions()`),
  `src/lib/programService.js`, `src/components/student/{JoinModal,ProgramCard}.jsx`,
  `src/pages/StudentProgramsPage.jsx` — 결정 5.
- `supabase/migrations/20260811160000_add_notification_session_date.sql` — 결정 6.
- `supabase/migrations/20260808100000_extend_notification_type.sql`(재실행 필요 — `promoted`/
  `rescheduled` 추가), `supabase/migrations/20260811200000_add_waitlist_promotion_notification.sql`,
  `src/components/student/NotifPopup.jsx` — 결정 7.
- `supabase/migrations/20260811220000_add_program_reschedule_notification.sql`,
  `src/components/student/NotifPopup.jsx` — 결정 8.
- `CLAUDE.md` 10장 — 학생 알림 목록에 `promoted`/`rescheduled` 추가(원칙 1~6 변경 없음, 단순 목록
  갱신).

### 마이그레이션 적용 순서

1. `20260808100000_extend_notification_type.sql` **전체 재실행**(이미 적용된 파일이지만
   `add value if not exists`라 안전 — 새로 추가된 `promoted`/`rescheduled` 두 줄만 실제로 커밋된다)
2. `20260811140000_add_waitlist_position.sql`
3. `20260811160000_add_notification_session_date.sql`
4. `20260811200000_add_waitlist_promotion_notification.sql`
5. `20260811220000_add_program_reschedule_notification.sql`

2·3번은 1번과 무관하게 독립적이라 순서가 바뀌어도 되지만, 4·5번은 1번이 먼저 커밋돼 있어야 한다
(새 enum 값을 쓰는 문장이 같은 트랜잭션에 있으면 55P04로 실패한다 — 이 프로젝트에 반복해 온 규율).

---

## 절대 원칙 체크

- **원칙 1** (게임화 금지): 대기 순번·신청자 수는 순위·경쟁이 아니라 사실 하나다(ADR 0016이 이미
  세운 논리를 순번에 그대로 적용). 게이지·퍼센트·"TOP" 라벨은 어디에도 없다.
- **원칙 4·6**: 영향 없음. 이 ADR의 어떤 결정도 관리자 기능 개수나 포인트 시각 위계를 건드리지 않는다.
- **CLAUDE.md 개정**: 10장의 알림 목록만 갱신했다(사실 나열이지 원칙이 아니다).

## 알려진 사항

- **대기 순번은 실시간이 아니다.** 다른 원칙 1~8 항목과 마찬가지로 "팝업을 열 때" 다시 읽는다 —
  같은 팝업을 계속 띄워 두고 있으면 다른 학생의 취소로 순번이 앞당겨져도 화면은 안 바뀐다.
- **기간제 알림도 여전히 "지연 계산"의 한계를 그대로 물려받는다.** `sync_my_notices()`는 화면을 열 때
  계산되므로, 그날 앱을 한 번도 안 열면 그날의 upcoming/exit_due 자체가 영영 안 만들어진다
  (20260808140000이 이미 문서화한 구조적 한계 — 이번 수정은 "프로그램당 1번"을 "날짜마다 1번"으로
  넓혔을 뿐 이 한계 자체를 없애지 않는다).
