# Accumu — 코드 지도

> **이 문서의 목적**: 프로젝트의 파일이 각각 무슨 일을 하는지, 그리고 **왜 그렇게 나뉘어 있는지**를
> 설명한다. 면접에서 *"이 파일은 뭐 하는 거예요?"*, *"이건 왜 이렇게 만드셨어요?"* 를 받았을 때
> 답할 수 있는 것이 목표다.
>
> 마지막 갱신: 2026-08-22 · 대상 커밋: `d4b7701`

---

## 0. 이 문서를 읽는 법

**전부 외우려고 하지 마라.** 파일이 88개인데 그걸 다 아는 사람은 없다. 대신 세 단계로 읽는다.

| 단계 | 읽을 것 | 걸리는 시간 | 이걸 알면 |
|---|---|---|---|
| **1단계** | 1장(뼈대) + 2장(지도) | 10분 | 구조를 한 문장으로 말할 수 있다 |
| **2단계** | 3장(흐름 추적) | 20분 | *"신청을 누르면 어떻게 되나요?"* 에 답할 수 있다 |
| **3단계** | 4~8장(폴더별) | 필요할 때 찾아보기 | 특정 파일을 지목당해도 답할 수 있다 |

**1·2단계만 확실히 해도 면접에서는 충분하다.** 3장의 흐름 하나를 손으로 그릴 수 있으면
그게 "구조를 이해했다"의 실질이다.

---

## 1. 먼저 알아야 할 뼈대 5가지

### ① 백엔드 서버가 없다

```
[학생 브라우저]  [관리자 브라우저]
       └──────── React (Vite) ────────┐
                                      │  supabase-js (anon key)
                                      ▼
                            ┌──────────────────┐
                            │    Supabase      │
                            │  PostgreSQL      │  ← 권한·규칙이 전부 여기 있다
                            │  Auth / Storage  │
                            │  Edge Function×3 │
                            └──────────────────┘
```

Node 서버도 Spring도 없다. 브라우저가 **Supabase에 직접** 요청한다.

> **왜?** 서버를 하나 더 두면 권한을 검사하는 곳이 두 군데(서버 + DB)가 된다. 두 곳이 시간이 지나며
> 어긋나면 어긋난 쪽이 곧 보안 구멍이 된다. 경계를 한 곳에만 두는 편이 1인 프로젝트에서 더 안전하다.

### ② 권한은 코드가 아니라 DB에 있다 — RLS

**RLS(Row Level Security, 행 수준 보안)** = *"이 테이블의 어떤 **행**을 누가 볼 수 있는가"* 를
데이터베이스가 직접 판정하는 기능.

```sql
-- 학생은 자기 참여 기록만 읽을 수 있다
create policy "participations_select_own"
  on public.participations for select to authenticated
  using (student_id = auth.uid());
```

이 정책이 있으면, 브라우저가 `select * from participations`를 그냥 보내도 **자기 행만** 돌아온다.
프런트엔드 코드에 `if (내 것이 아니면 숨긴다)` 같은 판단이 거의 없는 이유다.

> **왜?** 화면에서 숨기는 것은 UX일 뿐이고 개발자도구로 우회할 수 있다. 진짜 경계는 DB가 갖는다.

### ③ 여러 행에 걸친 일은 "서버 함수(RPC)"가 한다

RLS 정책은 *"이 행을 만져도 되는가"* 만 답한다. 그런데 어떤 일은 **여러 행을 한꺼번에** 바꿔야 한다.

예: 신청 취소 → 내 행을 지우고 + 대기자 한 명을 승격시켜야 한다. 이건 정책 하나로 표현할 수 없다.

그래서 DB 안에 **함수**를 만들고 브라우저가 그 함수를 호출한다(`supabase.rpc('함수명')`).

```
cancel_my_participation()   신청 취소 + 대기자 자동 승격
verify_participation_qr()   QR 검증 + 상태 변경 + 포인트 지급  (한 트랜잭션)
publish_my_program()        게시 조건 검사 후 공개
settle_my_points()          월 단위 지역화폐 정산
```

### ④ 컴포넌트는 Supabase를 직접 부르지 않는다 — 서비스 레이어

```
화면(pages/components)  →  src/lib/*Service.js  →  supabase
```

화면은 `programService.applyToProgram(...)` 처럼 **이름 있는 함수**만 부른다.
쿼리·에러 코드 해석·실패 문구는 전부 `src/lib/` 안에 모여 있다.

> **왜?** 같은 쿼리가 화면 세 곳에 흩어지면 규칙이 세 벌이 된다. 한 곳만 고치고 나머지를 잊는 사고가
> 이 프로젝트에서 실제로 여러 번 났고(→ ADR 0026 개정 1), 그래서 계속 한곳으로 모으는 방향으로 갔다.

### ⑤ 결정을 문서로 남겼다 — ADR 26건

`docs/adr/`에 **왜 그렇게 했는지**가 결정 단위로 하나씩 적혀 있다. 코드 주석에도 `ADR 0005` 같은
번호가 계속 나오는데, 그 번호를 따라가면 이유가 나온다.

---

## 2. 폴더 한 장 지도

```
Accumu/
├── src/                     ← 프런트엔드 (React) · 88개 파일 / 약 17,100줄
│   ├── main.jsx             앱 시작점 (React를 <div id="root">에 붙인다)
│   ├── App.jsx              ★ 라우트 표 — 어떤 주소가 어떤 화면인지
│   ├── pages/               화면 15개 (주소 하나 = 파일 하나)
│   ├── components/          화면 안에서 쓰이는 조각 (모달·카드·폼)
│   ├── lib/                 ★ 서비스 레이어 — Supabase와 대화하는 유일한 층
│   ├── routes/              접근 제어 + 공통 셸 배치
│   ├── context/             전역 상태 2개 (로그인 정보 / 튜토리얼 진행)
│   └── styles/              CSS 19개 (화면별로 나뉨)
│
├── supabase/
│   ├── migrations/          ★ DB 설계 44개 파일 / 약 9,800줄 — 테이블·정책·함수
│   └── functions/           Edge Function 3개 (네이버·구글 로그인, 비밀번호 초기화)
│
├── scripts/                 시딩 + 권한 테스트 + 초대코드 재발급
├── docs/                    ADR 26건 + 기능 명세 9건 + 보고서 + 이 문서
├── public/                  정적 파일
└── (설정) vite.config.js · eslint.config.js · vercel.json · index.html · CLAUDE.md
```

**규모 감각**

| | 개수 | 줄 수 |
|---|---|---|
| 프런트엔드 | 88개 | 약 17,100 |
| DB 마이그레이션 | 44개 | 약 9,800 |
| 권한 테스트 | 1개 | 101건 검사 |

> DB 코드가 프런트의 절반이 넘는다. 이 프로젝트에서 **규칙의 무게중심이 DB에 있다**는 뜻이고,
> 그게 ①②③의 결과다.

---

## 3. ★ 요청 하나가 흐르는 길 (제일 중요한 장)

파일 목록을 외우는 것보다 **하나의 동작을 끝까지 따라가는 것**이 훨씬 설명하기 쉽다.
세 가지만 익히면 된다.

### 3-1. 학생이 프로그램을 신청할 때

```
① StudentProgramsPage.jsx      화면: 목록에서 카드를 누른다
        ↓
② JoinModal.jsx                참여 팝업이 뜬다 (제목·날짜·포인트·신청자 수)
        ↓  "참석 신청하기" 클릭
③ programService.applyToProgram()      src/lib/ — insert 요청을 만든다
        ↓  supabase-js
④ RLS: participations_insert_own       DB — "본인 이름으로만, applied 상태로만" 검사
        ↓  통과
⑤ 트리거: participations_capacity_guard  DB — 정원이 찼으면 status를 waitlisted로 바꿔 넣는다
        ↓
⑥ 행 저장 → 서버가 status를 돌려준다   'applied'(자리 확보) 또는 'waitlisted'(대기)
        ↓
⑦ JoinModal이 결과에 맞는 문구를 띄운다
```

**여기서 말할 수 있는 것**
- *"정원 초과를 왜 프런트에서 안 막았나요?"* → 두 명이 동시에 누르면 프런트 검사는 둘 다 통과시킨다.
  정원은 **다른 행들을 세어야** 알 수 있는 조건이라 DB 트리거가 판정한다.
- *"거부가 아니라 대기로 바꾼 이유는?"* → 거부는 학생에게 **다음 행동을 주지 않는다.**

### 3-2. QR 입·퇴장 인증 (이 앱의 핵심)

```
[학생]                                      [관리자]
QrCenterModal.jsx                           AdminScanPage.jsx
  "입장 QR" 클릭                              카메라 화면 (html5-qrcode)
     ↓
participationService.issueQr()
     ↓
RPC: issue_participation_qr()   ← 서버가 1회용 토큰 10자 생성, 30분 만료
     ↓
화면에 QR 표시 (qrcode.react)  ─────────→  카메라로 스캔
                                              ↓
                                     participationService.verifyQr()
                                              ↓
                                     RPC: verify_participation_qr()
                                       · 관리자인가?
                                       · 내가 올린 프로그램인가?
                                       · 만료됐나 / 이미 썼나?
                                       · 통과 → 시각 기록 + 토큰 무효화
                                       · 퇴장이면 → 포인트 지급 + 원장 기록
                                              ↓
                                     결과를 관리자 화면에 표시
     ↑
학생 화면은 10초마다 상태를 확인해 "인증 완료"로 바뀐다
```

**여기서 말할 수 있는 것**
- *"QR에 뭐가 들어 있나요?"* → **토큰 문자열 하나뿐.** 참여ID·종류를 같이 넣었다가 뺐는데,
  서버가 검증에 쓰는 값이 토큰 하나였고 나머지는 위조 가능해서 신뢰할 수 없었다.
  덕분에 QR이 45×45에서 21×21로 성글어져 인식도 빨라졌다.
- *"토큰 재사용은 어떻게 막나요?"* → 검증 성공 시 서버가 토큰을 즉시 지운다. 동시에 두 번 스캔해도
  `for update` 잠금 + 조건부 update라 하나만 성공한다.

### 3-3. 관리자가 프로그램을 올릴 때 (게시 게이트)

```
AdminProgramsPage.jsx   "올리기" 클릭
        ↓
PublishConfirm 모달      ① 학생에게 보일 모습 미리보기
                        ② 체크리스트 3개 (학업 아님 / 무료 / 부적절하지 않음)
        ↓  전부 체크해야 버튼이 열린다
programService.publishMyProgram()
        ↓
RPC: publish_my_program()   ③ 서버 검사
                              · 내 프로그램인가
                              · 진행이 끝나지 않았나
                              · 설명이 50자 이상인가
                              · 기간제면 남은 진행일이 있나
        ↓  통과
트리거: programs_publish_gate   ← RPC를 거치지 않은 게시는 여기서 거부(42501)
        ↓
is_published = true → 모든 학생 목록에 나타남
```

**여기서 말할 수 있는 것**
- *"체크박스는 그냥 누르면 끝 아닌가요?"* → 맞다. 그래서 **체크한 3문장이 곧 학생이 신고할 수 있는
  3가지**다. 어기면 학생 3명의 신고로 자동으로 내려간다. 체크리스트만으로 막는 게 아니라
  *약속을 만들고, 어기면 되돌리는* 구조다.
- *"RPC만 만들면 되지 트리거는 왜?"* → 개발자도구에서 `update`를 직접 보내면 RPC를 건너뛴다.
  트리거가 `false → true` 전이만 골라 막는다.

---

## 4. `src/` — 프런트엔드

### 4-1. 시작점과 라우트

| 파일 | 하는 일 |
|---|---|
| `index.html` | 브라우저가 처음 받는 HTML. `<div id="root">` 하나뿐 |
| `src/main.jsx` | React를 그 div에 붙인다 |
| `src/App.jsx` | **라우트 표.** 주소 ↔ 화면 대응이 전부 여기 있다 |

**라우트 표 (App.jsx)**

```
/                        → 로그인 여부·역할에 따라 자동 이동 (RootRedirect)
/login                   → 로그인
/signup                  → 회원가입
/auth/naver              → 네이버 로그인 콜백
/auth/google             → 구글 로그인 콜백
/auth/reset-password     → 비밀번호 재설정 완료

/student                 → 학생 홈          ┐
/student/programs        → 프로그램 탐색     │ ProtectedRoute(role="student")
/student/archive         → 디지털 아카이브   │ 안쪽에서만 학생 셸이 렌더된다
/student/mypage          → 마이페이지        ┘

/admin                   → 관리자 홈                    ┐
/admin/scan              → QR 카메라 스캔                │ ProtectedRoute(role="admin")
/admin/programs          → 프로그램 관리                 │
/admin/mypage            → 관리자 마이페이지             │
/admin/mypage/students/:id → 담당 학생 아카이브 상세      ┘

*                        → 404
```

### 4-2. `src/routes/` — 접근 제어와 껍데기

| 파일 | 하는 일 | 왜 필요한가 |
|---|---|---|
| `ProtectedRoute.jsx` | 로그인 안 했으면 `/login`으로, 역할이 다르면 자기 홈으로 보낸다 | 학생이 `/admin`을 주소창에 쳐도 못 들어간다. **단, 이건 UX다** — 진짜 경계는 RLS |
| `StudentLayout.jsx` | 학생 공통 셸을 **한 번만** 마운트하고 그 안에 화면을 갈아 끼운다 | 페이지를 옮길 때마다 상단바가 다시 그려지면 깜빡인다 |
| `AdminLayout.jsx` | 관리자 쪽 같은 것 | |
| `RootRedirect.jsx` | `/` 로 들어오면 세션·역할을 보고 즉시 보낸다 | 로그인 상태에서 홈 주소를 치면 바로 자기 화면으로 |

### 4-3. `src/context/` — 전역 상태

| 파일 | 담는 것 |
|---|---|
| `AuthContext.jsx` | `session`(로그인 정보) · `profile`(이름·역할·포인트) · `loading` |
| `TutorialContext.jsx` | 신규 학생 가이드가 몇 단계까지 진행됐는가 |

> **왜 Redux를 안 썼나?** 전역으로 알아야 하는 값이 3개뿐이다. 상태 관리 라이브러리는 상태가
> 화면 여러 곳에서 복잡하게 얽힐 때 필요한데, 여기선 그렇지 않다.

### 4-4. `src/pages/` — 화면 15개

**학생**

| 파일 | 화면 | 핵심 |
|---|---|---|
| `StudentHomePage.jsx` | 홈 | 관심 계열 우선 추천 + 마일스톤 |
| `StudentProgramsPage.jsx` | 프로그램 탐색 | 유형 4종 × 계열 7종 필터, 검색, 정렬 3가지, 지난 프로그램 접기 |
| `StudentArchivePage.jsx` | 디지털 아카이브 | 완료 활동 자동 기록, 레이더 차트, **PDF 인쇄** |
| `StudentMyPage.jsx` | 마이페이지 | 포인트 원장, 지역화폐 정산 상자, 학교 변경, 비밀번호 변경 |

**관리자**

| 파일 | 화면 | 핵심 |
|---|---|---|
| `AdminHomePage.jsx` | 홈 | 오늘 진행 프로그램 우선 |
| `AdminProgramsPage.jsx` | 프로그램 관리 | 올리기(게시 게이트)·내리기·수정, 끝난 프로그램 수정 잠금 |
| `AdminScanPage.jsx` | QR 스캔 | 실제 카메라 권한 사용 (html5-qrcode) |
| `AdminMyPage.jsx` | 마이페이지 | 담당 학생 5명 목록, 초대코드 표시 |
| `AdminStudentArchivePage.jsx` | 담당 학생 상세 | 아카이브 조회 + PDF + 담당 해제 + 비밀번호 초기화 |

**공통 / 인증**

`LoginPage` · `SignupPage` · `NaverCallbackPage` · `GoogleCallbackPage` · `ResetPasswordPage` ·
`NotFoundPage` · `AdminPlaceholderPage` (개발 중 자리표시용)

### 4-5. `src/components/` — 화면 조각

**학생용** (`components/student/`)

| 파일 | 하는 일 |
|---|---|
| `StudentShell.jsx` | 상단바 + 하단 탭바 (알림·캘린더·아바타) |
| `ProgramCard.jsx` | 프로그램 카드 한 장 |
| `JoinModal.jsx` | 참여 신청 팝업 (+ 맨 아래 신고 진입) |
| `QrCenterModal.jsx` | **QR 목록 + QR 표시** — 학생 쪽 QR의 전부 (772줄, 두 번째로 큰 파일) |
| `ReportPanel.jsx` | 신고 패널 (사유 7종, 참여자 전용은 잠금) |
| `ReviewForm.jsx` | 별점 + 한줄평 |
| `NotifPopup.jsx` | 알림 팝업 (9종) |
| `CalendarPopup.jsx` | 활동 캘린더 |
| `PointLedger.jsx` | 포인트 내역 목록 |
| `StackViz.jsx` | 마일스톤 막대 시각화 |
| `ActivityDetailModal.jsx` | 아카이브 활동 행 클릭 시 상세 |
| `TutorialOverlay.jsx` | 신규 학생 가이드 오버레이 |

**관리자용** (`components/admin/`)

| 파일 | 하는 일 |
|---|---|
| `AdminShell.jsx` | 관리자 상단바 |
| `ProgramFormModal.jsx` | **프로그램 등록·수정 폼** (928줄, 가장 큰 파일) |
| `ImageCropper.jsx` | 대표 사진 자르기 (드래그 + 확대) |
| `AdminCalendarPopup.jsx` | 관리자 캘린더 |

> **ProgramFormModal이 왜 가장 큰가?** 등록과 수정이 **같은 컴포넌트**다. 둘로 나누면 검증 규칙이
> 두 벌이 되어 한쪽만 고치는 사고가 난다. 대신 파일 하나가 커지는 것을 받아들였다.

**아카이브용** (`components/archive/`) — 학생 화면과 관리자의 담당 학생 상세가 **같은 조각을 공유**한다.

`ArchiveHero` · `ArchiveSummary` · `ActivityList` · `TrackRadar` · `ArchivePrintHeader`

**공용** (`components/`)

| 파일 | 하는 일 |
|---|---|
| `Modal.jsx` | 모든 팝업의 껍데기 (포커스 트랩, Esc 닫기) |
| `Icon.jsx` | duotone SVG 아이콘 39종 (**이모지 금지** — 디자인 원칙) |
| `Toast.jsx` | 하단 알림 메시지 |
| `ErrorBoundary.jsx` | 화면이 터져도 흰 화면 대신 안내를 띄운다 |
| `RotateNotice.jsx` | 폰 가로 모드일 때 "세로로 돌려주세요" |
| `SocialLogin.jsx` | 네이버·구글 버튼 |
| `PasswordChangeForm` · `SchoolChangeForm` · `AccountHelpModal` | 계정 관리 폼들 |

### 4-6. ★ `src/lib/` — 서비스 레이어 (여기가 핵심)

**화면은 Supabase를 모른다. 이 폴더만 안다.**

| 파일 | 담당 | 대표 함수 |
|---|---|---|
| `supabaseClient.js` | Supabase 연결 1개 | — (anon key만 쓴다. service_role은 절대 안 들어간다) |
| `authService.js` | 로그인·회원가입·비밀번호 | `signInStudent()` `signUpStudent()` |
| `programService.js` | 프로그램 + 참여 | `fetchAllPrograms()` `applyToProgram()` `publishMyProgram()` |
| `participationService.js` | QR 발급·검증 | `issueQr()` `verifyQr()` |
| `archiveService.js` | 아카이브 조회·집계 | `fetchMyArchive()` |
| `pointService.js` | 포인트 원장·정산 | `fetchMyLedger()` `settleMyPoints()` |
| `reviewService.js` | 별점·한줄평 | `upsertMyReview()` |
| `reportService.js` | 신고 | `reportProgram()` |
| `notificationService.js` | 알림 | `fetchMyNotifications()` |
| `profileService.js` | 본인 프로필 수정 | `setMySchool()` |
| `taxonomy.js` | 유형 4종 · 계열 7종의 **이름·색·아이콘** | DB enum과 키가 같다 |
| `date.js` | 날짜 유틸 + `isProgramOver()` | "진행이 끝났는가" 판정의 **유일한 소유자** |
| `virtualEmail.js` | 학번 → `20250001@accumu.local` 변환 | |
| `programErrors.js` | DB 에러 코드 → 사람이 읽을 문구 | `23514` → "포인트는 150~3,000P…" |

> **`date.js`의 `isProgramOver()` 이야기** — "이 프로그램이 끝났는가"를 판정하는 코드가 원래 **다섯
> 군데에 각각** 있었다. 그중 일부가 종료일이 아니라 시작일만 봐서, 진행 중인 기간제 프로그램이
> "지난 것"으로 분류됐다. 한 곳을 고쳐도 나머지가 남아 화면마다 답이 달랐다. 지금은 한 함수다.

### 4-7. `src/styles/` — CSS 19개

화면별로 나뉜다(`StudentHome.css`, `AdminShell.css`, `Qr.css` …). 두 개만 특별하다.

| 파일 | 역할 |
|---|---|
| `tokens.css` | **디자인 토큰** — 색·폰트·그림자·모서리를 변수로 정의. 모든 CSS가 이 변수를 쓴다 |
| `print.css` | PDF 인쇄용. 버튼·네비를 숨기고 문서처럼 만든다 |

```css
--ink: #16213E      --bg: #EAEEF6
--brand: #2563EB    --amber: #E0922F   /* amber는 포인트 전용 */
```

---

## 5. `supabase/migrations/` — DB 설계 44개

### 마이그레이션이 뭔가

DB를 바꾸는 SQL을 **파일 하나 = 변경 하나**로 쌓아 둔 것이다. 파일명 앞 숫자가 날짜·시각이라
**순서대로 실행하면 빈 DB가 지금 상태가 된다.** 되돌리거나 건너뛰지 않고, 고칠 일이 있으면
**새 파일을 추가**한다.

> **왜 파일을 고치지 않고 새로 추가하나?** 이미 실행한 파일을 고치면 "저장소에 적힌 것"과
> "실제 DB에 적용된 것"이 달라진다. 그때부터 저장소를 믿을 수 없게 된다.

### 읽는 순서 (전부 읽을 필요 없다)

| 시기 | 파일 | 무엇이 생겼나 |
|---|---|---|
| 7/09 | `init_profiles_and_mentor_students` | 계정 + 관리자–담당학생 매핑 |
| 7/16 | `add_programs_and_career_track` | 프로그램 테이블, 유형·계열 |
| 7/16 | `add_participations` | 신청 기록 |
| **7/23** | **`add_qr_auth_and_admin_boundaries`** | **QR 토큰 발급·검증 (이 앱의 심장)** |
| 7/30 | `add_program_capacity_gate` | 정원 게이트 트리거 |
| 7/31 | `add_signup_invite_codes_and_account_types` | 회원가입 + 초대코드 |
| 8/06~08 | `add_notifications` 외 4건 | 인앱 알림 9종 |
| 8/07 | `add_monthly_currency_settlement` | 월 단위 지역화폐 정산 |
| 8/09 | `rebuild_taxonomy` | 유형 8종 → 4종 재편 |
| 8/09~11 | 기간제 프로그램 · 대기열 · 취소 | |
| 8/13~14 | 대표 사진 · 학교 이름 | |
| **8/20** | **`harden_invite_codes`** | **초대코드 난수화 (보안 사고 대응)** |
| 8/21 | `program_reports_and_admin_audit` | 학생 신고 + 감사 로그 |
| 8/22 | `report_scope_and_publish_gate` | 게시 게이트 + 신고 2분류 |

### 테이블 11개

| 테이블 | 담는 것 |
|---|---|
| `profiles` | 계정 (학생·관리자 공통). 이름·역할·포인트·학교 |
| `mentor_students` | 관리자–담당학생 매핑. **이 테이블 자체가 권한 경계다** |
| `invite_codes` | 가입 초대코드 (학교용 / 관리자 승격용) |
| `programs` | 프로그램 |
| `participations` | 신청·입장·퇴장 상태 + QR 토큰 |
| `attendance_sessions` | 기간제 프로그램의 날짜별 출석 |
| `point_transactions` | 포인트 원장 (적립/전환) |
| `reviews` | 별점 + 한줄평 |
| `notifications` | 인앱 알림 |
| `program_reports` | 학생 신고 |
| `admin_audit` | 관리자 행위 기록 (**읽는 화면이 0개** — SQL 콘솔 전용) |

> **`mentor_students`가 왜 "권한 경계 자체"인가?** 관리자가 담당 학생의 아카이브를 보는 화면에서
> *"이 학생이 내 담당인가"* 를 코드로 검사하지 **않는다.** 이 테이블에 매핑이 있는 학생만 조회
> 결과에 나오도록 RLS가 짜여 있어서다.

### SQL 파일 안에서 자주 보이는 것들

| 키워드 | 무엇인가 | 예 |
|---|---|---|
| `create table` | 테이블 만들기 | |
| `create policy` | **RLS 정책** — 누가 어떤 행을 볼/쓸 수 있는가 | `participations_select_own` |
| `create function` | 서버 함수(RPC) | `verify_participation_qr()` |
| `create trigger` | 행이 바뀔 때 자동 실행 | `participations_capacity_guard` |
| `check (...)` | 값 제약 | 포인트는 150~3,000, 끝자리 0 |
| `security definer` | 이 함수는 정책을 우회해 실행된다 | 여러 행을 봐야 하는 함수 |

---

## 6. `supabase/functions/` — Edge Function 3개

브라우저에서 하면 안 되는 일(비밀키를 쓰는 일)을 하는 **작은 서버 코드**. Supabase가 실행해 준다.

| 폴더 | 하는 일 |
|---|---|
| `naver-auth/` | 네이버 로그인 — 인증 코드를 받아 토큰 교환 + 세션 발급 |
| `google-auth/` | 구글 로그인 — 같은 방식 |
| `admin-reset-student-password/` | 관리자가 담당 학생 비밀번호를 초기화 |

> **구글은 Supabase가 기본 지원하는데 왜 직접 만들었나?** 처음엔 네이버만 직접 만들었는데, 그러면
> 두 제공자의 **설정하는 곳과 고장났을 때 볼 곳이 갈린다.** 시연 중 로그인이 안 되면 어디를 봐야
> 할지부터 갈리는 게 더 큰 비용이라, 둘을 같은 모양으로 통일했다.

> **비밀번호 초기화가 왜 필요한가?** 학번 계정은 `20250001@accumu.local` 이라는 **가상 이메일**이라
> 표준 "메일로 재설정 링크" 가 통하지 않는다(그 주소엔 받는 사람이 없다). 그래서 서버가 임시 비밀번호를
> 만들어 1회만 보여준다 — 관리자가 값을 직접 정하지 않는다.

---

## 7. `scripts/` — 실행용 도구

| 파일 | 하는 일 |
|---|---|
| `seed-accounts.mjs` | 데모 계정 생성 (학생 5명 + 관리자 1명) |
| `seed-programs.mjs` | 데모 프로그램 생성 |
| `seed-extra-programs.sql` | 추가 프로그램 (SQL 편집기용) |
| **`test-rls.mjs`** | **권한 경계 회귀 테스트 101건** |
| `rotate-admin-invite.sql` | 관리자 초대코드 재발급 |

### `test-rls.mjs` 가 하는 일 (면접에서 쓸 만한 이야기)

```bash
npm run test:rls        # → 전부 통과: 101개
```

anon / 학생 3명 / 관리자 2명의 세션으로 **금지된 요청 101건을 실제로 쏜다.**

```
anon    → programs insert                    기대: 42501 (거부)
학생    → 남의 학생 프로필 select              기대: 0행
학생    → 자기 포인트 잔액 직접 update         기대: 0행 영향
관리자A → 관리자B 프로그램 update              기대: 0행 영향
관리자B → 관리자A 프로그램의 QR 인증           기대: not_authorized
같은 QR 토큰 두 번 스캔                        기대: used
```

**통과가 아니라 거부를 기대하는 테스트가 대부분이다.** 그리고 검증 요청에 `service_role` 키를
쓰지 않는다 — 그 키는 RLS를 통째로 우회해서, 그걸로 테스트하면 **전부 통과하고 아무것도 검증하지
않는다.**

---

## 8. `docs/` — 문서

| 폴더/파일 | 내용 |
|---|---|
| `adr/` | **설계 결정 기록 26건** — 무엇을 왜 그렇게 정했는지 |
| `specs/` | 기능 명세 9건 — 화면별 요구사항 |
| `PROJECT-REPORT.md` | 입시 보고서·면접 대비 정리 (프로젝트 전체 이야기) |
| `CODE-MAP.md` | **이 문서** |
| `db/schema.sql` | 초기 스키마 (⚠️ 7/30 이후 갱신 안 됨 — 현재 진실은 `migrations/`) |

### ADR 읽는 법

파일 하나가 결정 하나다. 형식이 항상 같다.

```
배경 (무엇이 문제였나)
  → 결정 (무엇을 골랐나)
  → 대안으로 고려했던 것 (왜 그것들은 안 골랐나)
  → 원칙 체크 (프로젝트 원칙을 어기지 않는가)
  → 재검토 시점 (언제 다시 봐야 하나)
```

**면접에서 가장 쓸모 있는 3건**

| ADR | 이야기 |
|---|---|
| `0024` | 초대코드가 관리자 UUID로 **계산**되던 보안 구멍. 두 결정이 겹치는 자리에서 난 문제 |
| `0025` | 관리자 견제 — 학생 신고 + 감사 로그 |
| `0026` | 게시 게이트 + 신고 2분류. "안 열렸어요"가 **죽은 사유**였던 것 |

---

## 9. 설정 파일들

| 파일 | 하는 일 |
|---|---|
| `package.json` | 의존성 목록 + `npm run dev / build / lint / test:rls` |
| `vite.config.js` | 빌드 도구 설정. 시연용 터널 주소 허용이 들어 있다 |
| `eslint.config.js` | 코드 검사 규칙 |
| `vercel.json` | 배포 시 SPA 라우팅 (모든 주소를 index.html로) |
| `CLAUDE.md` | **프로젝트 헌법** — 원칙 6가지, 데이터 모델, 금지 사항 |
| `.env.local` | 앱이 쓰는 Supabase 주소·공개 키 (커밋 안 됨) |
| `.env.seed` | 시딩·테스트용 관리 키 (커밋 안 됨, **매우 민감**) |

> **`vercel.json`이 없으면 로그인이 아예 안 된다.** React 앱은 주소가 `/student/programs` 여도
> 실제 파일이 없다 — 서버가 `index.html`을 주고 그다음 React가 화면을 고른다. 이 설정이 그 규칙이다.

---

## 10. 자주 나올 질문과 답할 자리

| 질문 | 어느 파일을 열까 | 한 줄 답 |
|---|---|---|
| 전체 구조가 어떻게 되나요 | `src/App.jsx` | 라우트 표 하나로 화면 전체가 보인다 |
| 로그인은 어떻게 하나요 | `src/lib/authService.js` + `virtualEmail.js` | 학번을 가상 이메일로 바꿔 Supabase Auth에 넘긴다 |
| 권한은 어떻게 막나요 | `supabase/migrations/20260723120000_*.sql` | 화면이 아니라 DB의 RLS 정책이 막는다 |
| QR은 어떻게 동작하나요 | `QrCenterModal.jsx` + `verify_participation_qr()` | 3-2 흐름 그대로 |
| 포인트는 언제 지급되나요 | `verify_participation_qr()` 안 | **퇴장 인증이 끝나야** 지급. 같은 트랜잭션에서 원장까지 |
| 테스트는 하셨나요 | `scripts/test-rls.mjs` | 권한 경계 101건. 거부를 기대하는 테스트가 대부분 |
| 가장 어려웠던 점은 | `docs/PROJECT-REPORT.md` 7장 | 증상과 원인이 다른 층에 있던 사례 3개 |
| 보안은 어떻게 신경 썼나요 | `docs/adr/0024-*.md` | 실제로 구멍을 찾아 막은 이야기 |

---

## 11. 아직 이해가 안 되는 파일을 만났을 때

이 프로젝트의 파일은 **거의 전부 맨 위에 헤더 주석**이 있다. 거기에 (1) 무슨 파일인지 (2) 관련 ADR
번호 (3) 자주 하는 실수가 적혀 있다.

```bash
# 파일이 뭐 하는 건지 3초 만에 보기
head -20 src/lib/programService.js

# ">>>" 로 시작하는 줄은 "이렇게 하지 말 것" 경고다
grep -rn ">>>" src/lib/programService.js
```

**`>>>` 표시**는 *"다음에 이걸 고치려는 사람이 밟을 함정"* 을 적어 둔 것이다. 예:

```
>>> 학생 주도 전환 경로(버튼·금액 선택·즉시 전환 RPC)를 되살리지 말 것.
>>> applied 를 여기에 더하지 말 것. 더하는 순간 "신청 한 번 = 신고 자격"이 된다.
```

---

## 12. 마지막으로 — 정직하게 말하는 법

이 프로젝트는 AI 도구를 써서 만들었다. 그건 숨길 일도, 부끄러워할 일도 아니다.
다만 **무엇이 네 기여인지는 정확히 알고 있어야 한다.**

**네가 한 것**
- 문제 정의 — 비교과 활동 기록이 흩어진다는 것, QR 2회 인증으로 참여를 확인한다는 아이디어
- 원칙 6가지를 먼저 정하고 끝까지 지킨 것 (게임화 배제, 관리자 기능 5종 한정 …)
- 범위를 자른 것 — "안 만든 것"을 문서에 명시한 판단
- **실제로 결함을 찾아낸 것.** 최근 며칠만 봐도:
  - 진행 중인 기간제 프로그램이 "지난 프로그램"에 들어가던 버그
  - 관리자를 견제할 장치가 없다는 지적 → 신고 + 감사 로그가 생김
  - 신고 이유 30자가 너무 짧다는 지적 → 150/80자로
  - **"안 열렸어요"는 QR을 못 찍으니 참여자 전용이면 아무도 못 쓴다** — 설계 결함을 정확히 짚음

**모르는 걸 물으면**

*"그 부분은 정확히 기억이 안 나는데, 이런 이유로 그렇게 했습니다"* 라고 답하고, 이유를 말하면 된다.
**이유를 아는 것이 코드를 외우는 것보다 중요하다.** 실제 개발자도 자기가 쓴 코드를 한 달 뒤에는
기억하지 못하고, 그래서 이 프로젝트에는 ADR 26건이 있다.

모르는 것을 아는 척하는 것만 피하면 된다. *"그건 확인해 봐야 알 것 같습니다"* 는 감점이 아니다.
