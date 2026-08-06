-- Accumu v2 — 마이그레이션: 인앱 알림 (notifications)
-- 출처: CLAUDE.md 5장 데이터 모델(마지막 남은 미구현 테이블), docs/specs/notifications-calendar.md
--
-- 배경: 상단 종 아이콘은 지금까지 "빈 상태 팝업 껍데기"였다(student-home.md 확정 C).
--   근거 없는 dot 을 띄우지 않으려고 조회조차 하지 않았고, 그 판단이 이 테이블을 기다리고 있었다.
--
-- [★ 이 마이그레이션이 지키는 경계]
--   1. **학생은 알림을 만들 수 없다.** insert 정책이 0개다. 행은 오직 트리거(security definer)가 만든다.
--      알림은 "서버가 관측한 사실"이지 사용자가 쓰는 데이터가 아니다. 위조 가능하면 알림이 아니다.
--   2. **학생은 알림을 수정할 수 없다.** update 정책도 0개다. 읽음 처리는 RPC 로만 한다
--      (profiles 가 update 정책 0개 + RPC 로 가는 것과 같은 규율 — ADR 0007 결정 3-6).
--      정책을 열면 학생이 message 를 바꿔 쓸 수 있게 되고, 그 순간 알림이 증거로서 무의미해진다.
--   3. **관리자에게는 알림이 없다.** student_id 축뿐이고 관리자용 정책이 없다.
--      관리자 기능은 3종으로 고정이다(CLAUDE.md 2장 6번). 알림함은 4번째 기능이 된다.
--   4. **포인트를 이 테이블이 계산하지 않는다.** exit 알림의 금액은 programs.points 를 읽어 문구로
--      옮길 뿐이다. 지급은 여전히 verify_participation_qr() 안에서만 일어난다(절대 원칙 3).
--
-- [CLAUDE.md 5장과의 차이 — 의도된 확장 2개]
--   문서의 필드는 (id, student_id, type, message, is_read, created_at) 이다. 여기에 둘을 더한다:
--     - detail   : 두 번째 줄(프로그램명·날짜·적립액). 프로토타입 알림도 title + body 2줄이다(1147줄).
--     - program_id: 어떤 프로그램의 알림인지. 문구를 파싱하지 않고 화면이 맥락을 알 수 있다.
--   문구를 한 줄에 욱여넣으면 화면이 message 를 잘라 쓰게 된다 — 그게 더 나쁜 결합이다.

-- =========================================================
-- 1. 타입
--
-- 프로토타입의 NOTIF_IC(1139줄) 4종을 이 앱의 실제 이벤트에 맞춘다.
--   프로토타입 'qr'(참여 QR이 발급되었습니다)은 이 앱에 대응이 없다 — QR 은 신청 시점이 아니라
--   학생이 필요할 때 발급하므로, 그 자리를 'apply'(신청 완료)가 대신한다.
-- =========================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_type') then
    create type public.notification_type as enum ('new', 'apply', 'enter', 'exit');
  end if;
end $$;

-- =========================================================
-- 2. 테이블
-- =========================================================
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  type        public.notification_type not null,
  message     text not null,
  detail      text,
  program_id  uuid references public.programs(id) on delete cascade,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- 팝업은 "내 알림을 최신순으로" 한 가지 질의만 한다. 그 축에 맞춘 인덱스 하나면 충분하다.
create index if not exists notifications_student_created_idx
  on public.notifications (student_id, created_at desc);

comment on table public.notifications is
  '인앱 알림. 행은 트리거만 만든다(insert 정책 0개) — 학생이 쓰는 데이터가 아니라 서버가 관측한 사실이다.';
comment on column public.notifications.is_read is
  '읽음 처리는 mark_notifications_read() RPC 로만. update 정책이 0개라 학생이 직접 바꿀 수 없다.';

alter table public.notifications enable row level security;

-- select: 본인 것만. insert / update / delete 정책은 만들지 않는다(위 경계 1·2).
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select
  to authenticated
  using (student_id = auth.uid());

-- =========================================================
-- 3. 알림 생성 헬퍼 (security definer)
--
-- 트리거들이 공통으로 쓴다. 여기 한 곳만 통과하므로 "누가 알림을 만드는가"의 답이 하나다.
-- =========================================================
create or replace function public.notify_student(
  p_student_id uuid,
  p_type       public.notification_type,
  p_message    text,
  p_detail     text default null,
  p_program_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (student_id, type, message, detail, program_id)
  values (p_student_id, p_type, p_message, p_detail, p_program_id);
end;
$$;

-- 트리거 안에서만 쓰인다. 클라이언트가 직접 부르면 알림을 위조할 수 있으므로 실행 권한을 주지 않는다.
revoke all on function public.notify_student(uuid, public.notification_type, text, text, uuid) from public;
revoke all on function public.notify_student(uuid, public.notification_type, text, text, uuid) from authenticated;
revoke all on function public.notify_student(uuid, public.notification_type, text, text, uuid) from anon;

-- =========================================================
-- 4. 트리거 — 신청 / 입장 / 퇴장
--
-- [왜 RPC 안이 아니라 트리거인가] 입장·퇴장은 verify_participation_qr() 이 바꾸고, 신청은 학생이
--   직접 insert 한다. 경로가 둘로 갈리는데 트리거는 **어느 경로로 바뀌든** 잡는다. 나중에 관리자
--   경로가 하나 더 생겨도 알림이 조용히 빠지지 않는다.
-- =========================================================
create or replace function public.notifications_on_participation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title  text;
  v_date   date;
  v_points integer;
begin
  select p.title, p.date, p.points into v_title, v_date, v_points
  from public.programs p where p.id = new.program_id;

  v_title := coalesce(v_title, '프로그램');

  if tg_op = 'INSERT' then
    perform public.notify_student(
      new.student_id, 'apply', '참석 신청이 완료되었어요',
      v_title || coalesce(' · ' || to_char(v_date, 'MM월 DD일'), ''), new.program_id);
    return new;
  end if;

  -- 입장: entry_at 이 처음 채워지는 순간 1회만.
  if old.entry_at is null and new.entry_at is not null then
    perform public.notify_student(
      new.student_id, 'enter', '입장 인증이 완료되었어요',
      v_title, new.program_id);
  end if;

  -- 퇴장: exit_at 이 처음 채워지는 순간 1회만. 포인트는 같은 트랜잭션에서 이미 지급돼 있다.
  -- [문구에서 포인트를 앞세우지 않는다 — 절대 원칙 4] "참여가 완료되었어요"가 먼저고 적립은 부가 줄이다.
  if old.exit_at is null and new.exit_at is not null then
    perform public.notify_student(
      new.student_id, 'exit', '참여가 완료되었어요',
      v_title || coalesce(' · +' || v_points || 'P 적립', ''), new.program_id);
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_on_participation_insert on public.participations;
create trigger notifications_on_participation_insert
  after insert on public.participations
  for each row execute function public.notifications_on_participation();

drop trigger if exists notifications_on_participation_update on public.participations;
create trigger notifications_on_participation_update
  after update on public.participations
  for each row execute function public.notifications_on_participation();

-- =========================================================
-- 5. 트리거 — 새 프로그램 게시
--
-- [팬아웃을 감수한다] 게시 1회당 학생 수만큼 행이 생긴다. 데모 규모(학생 5~6명)에서는 무시할 수 있고,
--   "관리자가 올리면 학생 화면에 알림이 뜬다"는 시연에서 가장 잘 보이는 연결이다.
--   [주의] 학생이 수천 명이 되면 이 방식은 성립하지 않는다. 그때는 "게시 이벤트 1행 + 읽음 상태 분리"로
--   바꿔야 한다 — 지금 구조를 그대로 키우지 말 것.
-- [올릴 때만 쏜다] 내리기(true -> false)나 다른 컬럼 수정은 알림을 만들지 않는다.
-- =========================================================
create or replace function public.notifications_on_program_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_became_published boolean;
begin
  v_became_published := (tg_op = 'INSERT' and new.is_published)
    or (tg_op = 'UPDATE' and new.is_published and not old.is_published);

  if not v_became_published then
    return new;
  end if;

  insert into public.notifications (student_id, type, message, detail, program_id)
  select pr.id, 'new', '새 프로그램이 등록되었어요',
         new.title || ' · ' || new.org, new.id
  from public.profiles pr
  where pr.role = 'student';

  return new;
end;
$$;

drop trigger if exists notifications_on_program_published_insert on public.programs;
create trigger notifications_on_program_published_insert
  after insert on public.programs
  for each row execute function public.notifications_on_program_published();

drop trigger if exists notifications_on_program_published_update on public.programs;
create trigger notifications_on_program_published_update
  after update on public.programs
  for each row execute function public.notifications_on_program_published();

-- =========================================================
-- 6. 읽음 처리 RPC
--
-- update 정책이 0개이므로 이 함수가 유일한 쓰기 경로다. 바꿀 수 있는 것은 is_read 뿐이고,
-- 대상은 언제나 호출자 본인 행이다(auth.uid() 를 인자로 받지 않는다 — 받으면 남의 알림을 건드릴 수 있다).
-- =========================================================
create or replace function public.mark_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  update public.notifications
     set is_read = true
   where student_id = auth.uid()
     and is_read = false;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notifications_read() from public;
grant execute on function public.mark_notifications_read() to authenticated;

-- =========================================================
-- 시연 리셋 (참고)
--   delete from public.notifications;
--   -- participations 를 지우면 on delete cascade 로 알림도 함께 사라진다.
--   -- 단, 'new'(게시) 알림은 program_id 축이라 남는다. 위 delete 로 함께 정리한다.
-- =========================================================
