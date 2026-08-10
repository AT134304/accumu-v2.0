-- Accumu v2 — 추가 데모 프로그램 (2026-08-10, 케빈 요청 "시드 데이터를 좀 다양한 분야로 추가해줘")
--
-- [migrations/ 가 아니라 여기 있는 이유] 스키마 변경이 아니라 데이터 추가라 마이그레이션이 아니다.
--   scripts/seed-programs.mjs(Node)와 같은 목적이지만, 이 컴퓨터에 Node.js/scripts 의존성이 아직
--   설치되어 있지 않아 그 스크립트를 실행할 수 없다 — 대신 Supabase SQL 편집기에서 바로 붙여넣어
--   실행할 수 있는 순수 SQL로 만들었다. 지금까지 마이그레이션을 적용해온 것과 같은 방법이다.
--
-- [재실행 안전하지 않다 — 딱 한 번만 실행할 것] programs 에는 unique 제약이 없어서 이 파일을 두 번
--   실행하면 아래 11건이 그대로 중복 생성된다(홈에 중복 카드). 실수로 두 번 눌렀다면:
--     delete from public.programs where title in (
--       '경제 시사토론 동아리','전국 고교생 미술대회','요양원 말벗 봉사','법조인 진로 멘토링',
--       '교내 방송반 활동','청소년 경제경시대회','간호대학 체험의 날','다문화가정 학습멘토링',
--       '경기도 공유학교: 데이터사이언스 실습반','OO대학교 의학계열 진로체험 캠프',
--       '온라인학교: 인문고전 읽기 세미나'
--     );
--   (제목이 유니크하다는 보장은 없지만 데모 규모에서는 이 조건으로 충분하다.)
--
-- [기존 데이터를 건드리지 않는다] delete/update 없이 insert만 한다. 이미 만든 참여·포인트 기록과
--   완전히 무관하다.
--
-- [계열 분포를 노린 선택] 기존 17건은 biz(경영) 1건 / med(의약) 0건으로 눈에 띄게 적었다(ADR 0014가
--   이미 지적한 med 공백). 아래 11건 중 다수를 biz·art·med·soc·hum 에 배정해 7종 계열이 고르게
--   보이도록 했다 — CLAUDE.md 7장 포인트 규칙(150~3000, 끝자리 0)은 전부 만족한다.
--
-- [기간제 3건] 지급 방식 3종(20260809160000)을 각각 보여준다 — per_session / threshold / full.
--   진행일은 "오늘 + n일" 오프셋을 요일로 걸러 만든다(하드코딩 요일 없음 — dateFromToday 계열 규칙과 동일
--   이유). extract(dow from date)는 0=일~6=토로, 프런트(weekdayOf, getUTCDay)와 같은 값 공간이다.

-- =========================================================
-- 1. 단일 일자 프로그램 8건
-- =========================================================
insert into public.programs (
  category, title, description, org, date, time, points, career_track, popularity, status, is_published, created_by
) values
  ('school', '경제 시사토론 동아리',
   '시사 경제 이슈를 주제로 토론하며 경제적 사고력을 기르는 동아리.',
   '사회교과부', current_date + 12, '방과후', 280, 'biz', 40, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('contest', '전국 고교생 미술대회',
   '자유 주제로 참여하는 전국 단위 미술 실기 대회.',
   '한국미술협회', current_date + 20, '09:00–15:00', 900, 'art', 65, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('volunteer', '요양원 말벗 봉사',
   '지역 요양원 어르신들과 대화를 나누는 정기 봉사.',
   'OO시니어케어센터', current_date + 9, '14:00–16:00', 250, 'med', 35, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('career', '법조인 진로 멘토링',
   '현직 변호사에게 법조인의 하루와 진로를 직접 묻는 멘토링.',
   '대한변호사협회', current_date + 16, '13:00–15:00', 500, 'hum', 58, 'wait', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('school', '교내 방송반 활동',
   '아침·점심 방송을 기획하고 진행하는 방송반 정기 활동.',
   '방송부', current_date + 5, '점심시간', 220, 'art', 30, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('contest', '청소년 경제경시대회',
   '경제 개념과 시사를 종합적으로 평가하는 경시대회.',
   '한국은행', current_date + 23, '10:00–12:00', 1000, 'biz', 77, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('career', '간호대학 체험의 날',
   '간호대학 실습실을 직접 체험하는 진로 탐색 프로그램.',
   'OO대학교 간호대학', current_date + 14, '10:00–14:00', 550, 'med', 52, 'open', true,
   (select id from public.profiles where code = 'ADM-0001')),

  ('volunteer', '다문화가정 학습멘토링',
   '다문화가정 학생의 학습을 돕는 정기 멘토링 봉사.',
   'OO시 다문화가족지원센터', current_date + 11, '15:00–17:00', 380, 'soc', 44, 'open', true,
   (select id from public.profiles where code = 'ADM-0001'));

-- =========================================================
-- 2. 기간제 프로그램 3건 — 지급 방식 3종을 각각 보여준다
-- =========================================================

-- [per_session] 화·목 8회. 퇴장 인증마다 매번 지급.
with s as (
  select array(
    select (current_date + n)::date
    from generate_series(5, 32) n
    where extract(dow from current_date + n) in (2, 4)
  ) as dates
)
insert into public.programs (
  category, title, description, org, date, end_date, time, points, career_track,
  popularity, status, is_published, created_by, attendance_payout_mode, min_attendance_days, session_dates
)
select
  'career', '경기도 공유학교: 데이터사이언스 실습반',
  '데이터 수집부터 시각화까지 실습 중심으로 배우는 공유학교 강좌. 매주 화·목 진행되며, 참여할 때마다 포인트가 지급됩니다.',
  '경기도교육청 공유학교',
  s.dates[1], s.dates[array_length(s.dates, 1)], '16:00–18:00', 200, 'eng',
  70, 'open', true, (select id from public.profiles where code = 'ADM-0001'),
  'per_session', null, s.dates
from s;

-- [threshold] 토·일 약 3주. 최소 참여일수(전체-2일) 도달 시 1회 지급 — 종료일 전에 끝날 수 있다.
with s as (
  select array(
    select (current_date + n)::date
    from generate_series(12, 33) n
    where extract(dow from current_date + n) in (0, 6)
  ) as dates
)
insert into public.programs (
  category, title, description, org, date, end_date, time, points, career_track,
  popularity, status, is_published, created_by, attendance_payout_mode, min_attendance_days, session_dates
)
select
  'career', 'OO대학교 의학계열 진로체험 캠프',
  '의학 계열 진로를 탐색하는 대학 연계 주말 체험 프로그램. 전체 일정 중 일부만 채워도 포인트를 받을 수 있습니다.',
  'OO대학교 의과대학',
  s.dates[1], s.dates[array_length(s.dates, 1)], '09:00–13:00', 800, 'med',
  60, 'open', true, (select id from public.profiles where code = 'ADM-0001'),
  'threshold', greatest(1, array_length(s.dates, 1) - 2), s.dates
from s;

-- [full] 매주 수요일 6주. 종료일 퇴장 인증 시 1회 지급(기존 단일 일자와 같은 지급 시점).
with s as (
  select array(
    select (current_date + n)::date
    from generate_series(7, 44) n
    where extract(dow from current_date + n) = 3
  ) as dates
)
insert into public.programs (
  category, title, description, org, date, end_date, time, points, career_track,
  popularity, status, is_published, created_by, attendance_payout_mode, min_attendance_days, session_dates
)
select
  'career', '온라인학교: 인문고전 읽기 세미나',
  '매주 한 권씩 인문고전을 읽고 토론하는 온라인학교 강좌. 전 회차를 마쳐야 포인트가 지급됩니다.',
  '경기도교육청 온라인학교',
  s.dates[1], s.dates[array_length(s.dates, 1)], '19:00–20:30', 400, 'hum',
  45, 'open', true, (select id from public.profiles where code = 'ADM-0001'),
  'full', null, s.dates
from s;
