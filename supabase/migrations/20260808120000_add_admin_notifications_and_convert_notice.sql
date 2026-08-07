-- Accumu v2 — 관리자 알림 + 지역화폐 전환 알림 (ADR 0013)
-- 출처: docs/adr/0013-admin-notifications.md
--
-- [무엇이 바뀌는가]
--   1) 알림의 수신자 축이 "학생"에서 "사람"으로 넓어진다 (student_id -> recipient_id).
--   2) 관리자 알림 3종 신설: apply_admin(내 프로그램에 새 신청) / mentee(담당 학생 추가) /
--      stale(일정이 지난 게시중 프로그램 — 내려도 됩니다).
--   3) 학생 알림 1종 신설: convert(지역화폐 전환 완료 — ADR 0012 정산과 같은 트랜잭션).
--
-- [★ 원칙 6 을 어떻게 지키는가 — 이 마이그레이션의 가장 중요한 경계]
--   20260806120000 은 "관리자에게는 알림이 없다. 알림함을 주면 관리자 기능이 4번째가 된다"고 적었다.
--   그 판단을 케빈 요청으로 뒤집되, 뒤집는 근거를 여기 못박는다:
--     관리자 기능 3종은 **동작**(프로그램 관리 / 담당 학생 아카이브 / QR 스캔)이다.
--     아래 알림 3종은 전부 **그 3종에 관한 사실**이고 새로운 동작을 만들지 않는다.
--       apply_admin -> 내가 올린 프로그램 (프로그램 관리)
--       mentee      -> 담당 학생 경계가 바뀜 (담당 학생 아카이브)
--       stale       -> 내려도 되는 프로그램 (프로그램 관리)
--   >>> 규율: **알림 종류가 3종 기능 밖의 사실을 나르기 시작하면 그때가 원칙 6 위반이다.**
--       예) 학교 전체 참여 통계, 다른 관리자의 활동, 학생 성취 요약 -> 추가 금지.
--
-- [★ 알려진 경계 넓힘 — 감수하고 기록한다]
--   ADR 0005 결정 7-2(d)는 "관리자는 담당 학생의 completed 참여 외에 participations 를 읽을 수 없다"로
--   신청자 명단·참여자 수를 닫아 두었다. apply_admin 알림은 그 축을 **한 칸 연다** — 알림 개수를 세면
--   신청 건수를 알 수 있다.
--   그래서 **학생 이름을 넣지 않는다.** 문구는 "새로운 참석 신청이 있어요" + 프로그램명뿐이고,
--   누가 신청했는지는 여전히 알 수 없다(= 명단은 닫힌 채로 남는다).
--   >>> 이 알림의 detail 에 학생 이름·학번·인원수를 추가하지 말 것. 그 순간 명단이 열린다.
--
--   재실행해도 안전하다.

-- =========================================================
-- 1. 타입 확장
--
-- [enum 에 값을 더하는 이유 — 새 컬럼을 만들지 않는다]
--   수신자가 학생인지 관리자인지는 recipient_id 가 가리키는 profiles.role 로 이미 정해진다.
--   'is_admin_notice' 같은 플래그를 더하면 같은 사실이 두 곳에 생긴다.
--
-- [주의] alter type ... add value 는 같은 트랜잭션 안에서 그 값을 **사용**할 수 없다(PG 제약).
--   아래 함수들은 본문에 문자열로만 등장하고 실행은 런타임이라 문제가 없다.
--   혹시 "unsafe use of new value" 오류가 나면 이 스크립트를 한 번 더 실행하면 통과한다.
-- =========================================================
alter type public.notification_type add value if not exists 'convert';
alter type public.notification_type add value if not exists 'apply_admin';
alter type public.notification_type add value if not exists 'mentee';
alter type public.notification_type add value if not exists 'stale';

-- =========================================================
-- 2. student_id -> recipient_id
--
-- [이름을 바꾸는 이유] 컬럼이 관리자 행도 담게 되는 순간 student_id 라는 이름은 거짓말이 된다.
--   profiles 는 학생·관리자 공통 테이블이므로 FK 는 그대로 두고 이름만 사실에 맞춘다.
--   테이블이 만들어진 지 이틀이고 데이터가 데모뿐이라 지금이 가장 싼 시점이다.
-- =========================================================
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications' and column_name = 'student_id'
  ) then
    alter table public.notifications rename column student_id to recipient_id;
  end if;
end $$;

alter index if exists public.notifications_student_created_idx
  rename to notifications_recipient_created_idx;

comment on column public.notifications.recipient_id is
  '알림 수신자(profiles.id). 학생일 수도 관리자일 수도 있다 — 수신자의 역할은 profiles.role 이 소유하며 '
  '이 테이블은 플래그를 따로 두지 않는다. 2026-08-08 이전 이름은 student_id 였다(ADR 0013).';

-- select 정책을 새 컬럼 이름으로 다시 만든다. insert/update/delete 정책은 여전히 0개다.
-- >>> 관리자에게도 "본인 수신분만" 이라는 같은 규칙이 그대로 적용된다. 관리자용 별도 정책을 만들지 말 것.
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
  on public.notifications for select
  to authenticated
  using (recipient_id = auth.uid());

-- [stale 알림의 멱등성] 아래 sync_stale_program_notices() 는 관리자가 화면에 들어올 때마다 호출된다.
--   "일정이 지났다"는 사건이 아니라 상태라 트리거로 잡을 수 없고, 그래서 매번 계산한다.
--   같은 프로그램에 대해 두 번째 행이 생기지 않게 하는 것이 이 부분 unique 인덱스다
--   (ADR 0012 의 unique (student_id, settled_month) 와 같은 기법).
create unique index if not exists notifications_stale_once_idx
  on public.notifications (recipient_id, program_id)
  where type = 'stale';

-- =========================================================
-- 3. notify_user() — 알림 생성 헬퍼 (구 notify_student)
--
-- 트리거/정산 함수가 공통으로 쓴다. "누가 알림을 만드는가"의 답이 이 함수 하나다.
-- 실행 권한을 아무에게도 주지 않는다 — 클라이언트가 부를 수 있으면 알림을 위조할 수 있다.
-- =========================================================
create or replace function public.notify_user(
  p_recipient_id uuid,
  p_type         public.notification_type,
  p_message      text,
  p_detail       text default null,
  p_program_id   uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (recipient_id, type, message, detail, program_id)
  values (p_recipient_id, p_type, p_message, p_detail, p_program_id);
end;
$$;

revoke all on function public.notify_user(uuid, public.notification_type, text, text, uuid) from public;
revoke all on function public.notify_user(uuid, public.notification_type, text, text, uuid) from authenticated;
revoke all on function public.notify_user(uuid, public.notification_type, text, text, uuid) from anon;

-- =========================================================
-- 4. 참여 트리거 — 학생 알림(기존 3종) + 관리자 알림(apply_admin, 신규)
--
-- [한 트리거가 둘을 만든다] 같은 사건(신청)의 양쪽 당사자에게 가는 알림이라 경로를 쪼개지 않는다.
--   쪼개면 한쪽만 조용히 빠지는 형태의 버그가 생긴다.
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
  v_owner  uuid;
begin
  select p.title, p.date, p.points, p.created_by
    into v_title, v_date, v_points, v_owner
    from public.programs p
   where p.id = new.program_id;

  v_title := coalesce(v_title, '프로그램');

  if tg_op = 'INSERT' then
    perform public.notify_user(
      new.student_id, 'apply', '참석 신청이 완료되었어요',
      v_title || coalesce(' · ' || to_char(v_date, 'MM월 DD일'), ''), new.program_id);

    -- [관리자에게 — 이름 없이] 위 헤더의 "알려진 경계 넓힘" 참고. 누가 신청했는지는 담지 않는다.
    --   >>> 이 detail 에 학생 이름/학번/인원수를 추가하지 말 것. 신청자 명단이 열린다.
    if v_owner is not null then
      perform public.notify_user(
        v_owner, 'apply_admin', '새로운 참석 신청이 있어요',
        v_title || coalesce(' · ' || to_char(v_date, 'MM월 DD일'), ''), new.program_id);
    end if;

    return new;
  end if;

  -- 입장: entry_at 이 처음 채워지는 순간 1회만.
  if old.entry_at is null and new.entry_at is not null then
    perform public.notify_user(
      new.student_id, 'enter', '입장 인증이 완료되었어요', v_title, new.program_id);
  end if;

  -- 퇴장: exit_at 이 처음 채워지는 순간 1회만. 포인트는 같은 트랜잭션에서 이미 지급돼 있다.
  -- [문구에서 포인트를 앞세우지 않는다 — 절대 원칙 4] "참여가 완료되었어요"가 먼저고 적립은 부가 줄이다.
  if old.exit_at is null and new.exit_at is not null then
    perform public.notify_user(
      new.student_id, 'exit', '참여가 완료되었어요',
      v_title || coalesce(' · +' || v_points || 'P 적립', ''), new.program_id);
  end if;

  return new;
end;
$$;

-- =========================================================
-- 5. 게시 트리거 — 컬럼 이름만 갱신 (동작 동일)
--
-- [관리자에게 팬아웃하지 않는다] where pr.role = 'student' 그대로다. 내가 올린 프로그램이 게시됐다는
--   알림은 스스로 한 행동의 되풀이라 정보가 0이다.
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

  insert into public.notifications (recipient_id, type, message, detail, program_id)
  select pr.id, 'new', '새 프로그램이 등록되었어요',
         new.title || ' · ' || new.org, new.id
    from public.profiles pr
   where pr.role = 'student';

  return new;
end;
$$;

-- =========================================================
-- 6. 담당 학생 추가 트리거 (mentee)
--
-- mentor_students 는 권한 경계 그 자체라 앱에 편집 UI 가 없고, 행이 생기는 경로는 시딩과
-- 학생의 초대코드 입력 2가지뿐이다(CLAUDE.md 5장). 두 경로 모두 이 트리거를 지난다.
--
-- [여기서는 이름을 담는다] 담당 학생은 관리자가 이미 아카이브에서 이름을 볼 수 있는 대상이다
-- (admin_students 정책). apply_admin 과 달리 새로 여는 정보가 없다.
-- =========================================================
create or replace function public.notifications_on_mentor_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  select pr.name into v_name from public.profiles pr where pr.id = new.student_id;

  perform public.notify_user(
    new.admin_id, 'mentee', '담당 학생이 추가되었어요',
    coalesce(v_name, '학생') || ' 님이 내 학교 초대코드로 연동했어요', null);

  return new;
end;
$$;

drop trigger if exists notifications_on_mentor_link_insert on public.mentor_students;
create trigger notifications_on_mentor_link_insert
  after insert on public.mentor_students
  for each row execute function public.notifications_on_mentor_link();

-- =========================================================
-- 7. sync_stale_program_notices() — "일정이 지났는데 아직 게시중" 알림
--
-- [RPC 권한 경계] sync_stale_program_notices()
--   호출 가능: authenticated. 본문에서 (a) 로그인 (b) **관리자일 것** 을 검사한다.
--   허용 대상: auth.uid() 가 created_by 인 프로그램뿐. 인자가 0개라 남의 프로그램을 훑을 경로가 없다.
--   쓰는 컬럼: notifications 1행(프로그램당 최대 1회). programs 는 읽기만 한다.
--   불가능: 학생 호출(42501), 남의 프로그램 검사(경로 없음), 중복 알림(부분 unique 인덱스)
--
-- [★ 트리거가 아니라 지연 계산인 이유]
--   "일정이 지났다"는 **사건이 아니라 시간이 지나면서 참이 되는 상태**다. 트리거는 행이 바뀔 때만
--   깨어나므로 아무도 건드리지 않는 프로그램에서는 영원히 발화하지 않는다.
--   ADR 0012 의 settle_my_points() 와 같은 판단이다 — 답이 날짜의 함수라 언제 계산해도 같으므로
--   화면에 들어올 때 계산한다. pg_cron 을 켜지 않는다.
--
-- [내리지는 않는다 — 알리기만 한다] 게시 상태를 바꾸는 유일한 경로는 관리자의 내리기 토글이다
--   (admin-programs.md 확정 D). 이 함수가 is_published 를 건드리면 관리자 동의 없이 프로그램이
--   사라지는 것이고, 그건 4번째 관리자 기능(자동 운영)을 서버에 만드는 일이다.
--   >>> 이 함수 안에서 programs 를 update 하지 말 것.
-- =========================================================
create or replace function public.sync_stale_program_notices()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := auth.uid();
  v_today date;
  v_count integer := 0;
begin
  if v_admin is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception '관리자만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  -- 날짜 기준은 KST. programs.date 는 date 컬럼이라 그 자체가 한국 달력의 날짜다.
  v_today := (now() at time zone 'Asia/Seoul')::date;

  -- on conflict do nothing = 부분 unique 인덱스에 맡긴다. 조건문으로 "이미 있나" 를 세지 않는다
  -- (동시 요청 두 건이 같은 검사를 통과하는 창을 만들지 않는다).
  insert into public.notifications (recipient_id, type, message, detail, program_id)
  select p.created_by, 'stale', '일정이 지난 프로그램이 있어요',
         p.title || ' · ' || to_char(p.date, 'MM월 DD일') || ' 종료 · 내려도 괜찮아요',
         p.id
    from public.programs p
   where p.created_by = v_admin
     and p.is_published = true
     and p.date < v_today
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.sync_stale_program_notices() is
  '[ADR 0013] 일정이 지났는데 아직 게시중인 내 프로그램에 대해 "내려도 괜찮아요" 알림을 만든다. '
  '트리거가 아니라 관리자 화면 진입 시 지연 계산이다 — "일정이 지났다"는 사건이 아니라 시간이 지나면 '
  '참이 되는 상태라 트리거가 깨어날 계기가 없다(ADR 0012 settle_my_points 와 같은 판단). '
  '[알리기만 한다] is_published 를 건드리지 않는다. 내리기는 관리자의 토글이 유일한 경로다. '
  '[멱등] notifications_stale_once_idx 부분 unique 인덱스 + on conflict do nothing.';

revoke all on function public.sync_stale_program_notices() from public;
grant execute on function public.sync_stale_program_notices() to authenticated;

-- =========================================================
-- 8. mark_notifications_read() — 컬럼 이름 갱신
--
-- [자동 읽음으로 바뀌었다 — 2026-08-08] 화면의 "모두 읽음" 버튼이 사라지고 팝업을 열면 호출된다.
--   서버 쪽 규칙은 그대로다: 바꿀 수 있는 것은 is_read 뿐이고 대상은 언제나 호출자 본인 행이다.
--   >>> 인자를 추가하지 말 것. recipient_id 를 인자로 받는 순간 남의 알림을 읽음 처리할 수 있다.
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
   where recipient_id = auth.uid()
     and is_read = false;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notifications_read() from public;
grant execute on function public.mark_notifications_read() to authenticated;

-- =========================================================
-- 9. settle_my_points() — 정산 성공 시 convert 알림 (ADR 0012 + 이번 추가)
--
-- 바뀐 곳은 루프 안의 notify_user 한 줄뿐이다. 정산 로직·멱등성·경계는 20260807120000 그대로다.
-- [같은 트랜잭션이다] 알림만 따로 만들면 "전환은 됐는데 알림이 없는" 상태가 생길 수 있다.
-- [원칙 4] 제목은 "지역화폐로 전환되었어요"이고 금액은 부가 줄이다 — exit 알림과 같은 규율.
-- =========================================================
create or replace function public.settle_my_points()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student  uuid := auth.uid();
  v_today    date;
  v_row      record;
  v_settled  jsonb := '[]'::jsonb;
  v_pending  jsonb := '[]'::jsonb;
  v_balance  integer;
  v_total    integer;
  v_currency integer;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  v_today := (now() at time zone 'Asia/Seoul')::date;

  for v_row in
    with earned as (
      select (date_trunc('month', t.created_at at time zone 'Asia/Seoul'))::date as m,
             sum(t.amount)::integer as amt
        from public.point_transactions t
       where t.student_id = v_student
         and t.type = '적립'
       group by 1
    )
    select e.m,
           e.amt,
           ((e.m + interval '2 months')::date - 1) as settle_on
      from earned e
     where ((e.m + interval '2 months')::date - 1) <= v_today
       and not exists (
             select 1
               from public.point_transactions s
              where s.student_id = v_student
                and s.type = '전환'
                and s.settled_month = e.m
           )
     order by e.m
  loop
    update public.profiles
       set points_balance   = points_balance   - v_row.amt,
           currency_balance = currency_balance + v_row.amt
     where id = v_student
       and points_balance >= v_row.amt;

    if not found then
      -- [알려진 틈 — 레거시 계정] ADR 0012 "알려진 틈" 참고. 부분 정산으로 때우지 않고 건너뛴다.
      continue;
    end if;

    insert into public.point_transactions (student_id, type, amount, related_participation_id, settled_month)
    values (v_student, '전환', v_row.amt, null, v_row.m);

    -- 신규(2026-08-08): 전환 알림. 정산과 같은 트랜잭션이라 둘이 어긋날 수 없다.
    perform public.notify_user(
      v_student, 'convert', '지역화폐로 전환되었어요',
      to_char(v_row.m, 'YYYY년 MM월') || ' 적립분 · ' || v_row.amt || 'P → ₩' || v_row.amt, null);

    v_settled := v_settled || jsonb_build_object(
      'month', v_row.m, 'amount', v_row.amt, 'settle_on', v_row.settle_on
    );
  end loop;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('month', x.m, 'amount', x.amt, 'settle_on', x.settle_on)
             order by x.m
           ),
           '[]'::jsonb
         )
    into v_pending
    from (
      select e.m, e.amt, ((e.m + interval '2 months')::date - 1) as settle_on
        from (
          select (date_trunc('month', t.created_at at time zone 'Asia/Seoul'))::date as m,
                 sum(t.amount)::integer as amt
            from public.point_transactions t
           where t.student_id = v_student
             and t.type = '적립'
           group by 1
        ) e
       where not exists (
               select 1
                 from public.point_transactions s
                where s.student_id = v_student
                  and s.type = '전환'
                  and s.settled_month = e.m
             )
    ) x;

  select p.points_balance, p.points_total, p.currency_balance
    into v_balance, v_total, v_currency
    from public.profiles p
   where p.id = v_student;
  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'ok', true,
    'settled', v_settled,
    'pending', v_pending,
    'points_balance', v_balance,
    'points_total', v_total,
    'currency_balance', v_currency
  );
end;
$$;

revoke all on function public.settle_my_points() from public;
grant execute on function public.settle_my_points() to authenticated;

-- =========================================================
-- 10. 구 헬퍼 정리
--   notify_student 를 참조하던 함수는 위에서 전부 notify_user 로 갈아탔다.
-- =========================================================
drop function if exists public.notify_student(uuid, public.notification_type, text, text, uuid);

-- =========================================================
-- 시연 리셋 (참고)
--   delete from public.notifications;
-- =========================================================
