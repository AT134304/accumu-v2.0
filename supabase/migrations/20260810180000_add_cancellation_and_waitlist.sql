-- Accumu v2 — 마이그레이션: 신청 취소 + 정원 초과 시 자동 대기열 + 신청자 수 공개
--
-- [배경 — 케빈 요청, 2026-08-10]
--   "신청 취소 버튼을 만드는데 이제 프로그램 시작 전날까지만 가능하게 기능 추가하고, 정원이 차면
--    자동으로 신청 아이콘이 대기로 바뀌게 해줘. 신청자 수를 보이게 해."
--
-- [원칙을 깨는 결정임을 분명히 한다] ADR 0006이 명시적으로 막아 온 두 가지를 이번에 연다:
--   - 결정 6: "밖으로 나가는 것은 '찼다'라는 1비트뿐" — 신청자 수(정확한 카운트)는 절대 노출하지 않는다.
--   - 결정 2 "수용": "신청만 하고 안 온 학생이 자리를 막는다... 취소가 생기면 이 규칙을 재검토한다."
--   ADR 0006은 이 두 결정 모두에 스스로 "재검토 시점"을 못박아 뒀다(결정 1-3 말미, 결정 2 결정문 안).
--   케빈이 그 시점을 확정했다 — 이 마이그레이션은 그 반영이다. 근거·범위는
--   docs/adr/0016-cancellation-waitlist-and-applicant-count.md.
--
-- [범위]
--   1) today_kst() — KST 오늘 날짜. sync_my_notices() 가 인라인으로 하던 계산을 재사용 가능하게 뺐다.
--   2) participations_capacity_guard() 재정의 — 정원이 차면 거부(P0001) 대신 status='waitlisted'로
--      통과시킨다. for update 잠금·중복 신청 통과·NULL 무제한 처리는 ADR 0006 그대로.
--   3) participations_insert_own 재정의 — with check의 status 절을 'applied' 하나에서
--      ('applied','waitlisted') 둘로 넓힌다. 그 외 8개 절은 SQL 한 글자도 바꾸지 않는다.
--   4) cancel_my_participation(uuid) 신규 — 취소 + 대기열 승격을 한 트랜잭션으로.
--   5) program_applicant_counts() 신규 — 프로그램별 확정 인원(applied/entered/completed) 수만 반환.
--      신청자 명단·학번·이름은 여전히 절대 반환하지 않는다(ADR 0005 결정 7-2(d)는 이 마이그레이션이
--      건드리는 범위가 아니다 — 그건 "누가"이고 이건 "몇 명"이다).
--   6) sync_my_notices() 재정의 — 'waitlisted' 참여가 (3-기간제) upcoming 조건에 잘못 걸리던 것을 보정.
--   7) issue_attendance_qr() 재정의 — waitlisted 참여가 기간제 QR을 발급받을 수 있던 구멍을 막는다
--      (아래 7번 설명 참고 — 프런트 필터만으로는 막히지 않는 실제 권한 경계 문제였다).
--
-- [실행 순서] 20260810160000(enum 값 커밋) 이후.

-- =========================================================
-- 1. today_kst() — KST 오늘. sync_my_notices()/cancel_my_participation() 이 공유한다.
-- =========================================================
create or replace function public.today_kst()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Seoul')::date;
$$;

comment on function public.today_kst() is
  '서버 기준 오늘(KST, date). "오늘/내일/시작 전날" 판정이 필요한 함수(sync_my_notices, '
  'cancel_my_participation)가 각자 인라인으로 계산하던 것을 하나로 모았다 — 두 곳이 다른 타임존 계산을 '
  '쓰게 되는 드리프트를 막는다.';

revoke all on function public.today_kst() from public;
grant execute on function public.today_kst() to authenticated;

-- =========================================================
-- 2. participations_capacity_guard() 재정의 — 거부 대신 대기열
--
-- [바뀐 부분 — ADR 0016] (6) 절만 바뀐다. 정원이 차면 raise exception 대신 new.status 를
--   'waitlisted' 로 바꿔 통과시킨다. 나머지(잠금·NULL 무제한·중복 신청 통과·status 무관 카운트)는
--   ADR 0006 그대로 — "정원은 insert 시점의 게이트일 뿐" 이라는 결정 1-5는 안 바뀐다. 여전히 QR
--   검증 경로(update)에는 이 트리거가 붙지 않는다.
-- [정확한 count가 필요한 이유는 그대로다] security definer — invoker면 count가 본인 행만 보여
--   waitlisted 전환이 조용히 무력화된다(ADR 0006 결정 3-b와 동일 논리).
-- =========================================================
create or replace function public.participations_capacity_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_taken    integer;
begin
  select p.capacity into v_capacity
    from public.programs p
   where p.id = new.program_id
   for update;

  if not found then
    return new;
  end if;

  if v_capacity is null then
    return new;
  end if;

  if exists (
    select 1
      from public.participations
     where program_id = new.program_id
       and student_id = new.student_id
  ) then
    return new;
  end if;

  -- status 무관 카운트 그대로(ADR 0006 F-2) — waitlisted 행도 이미 "신청됨"의 일부라 계속 센다.
  -- 그래야 정원이 한 번 차면 그 뒤 신청은 전부(취소로 자리가 나기 전까지) waitlisted 로 유지된다.
  select count(*) into v_taken
    from public.participations
   where program_id = new.program_id;

  if v_taken >= v_capacity then
    -- [바뀐 부분 — ADR 0016] 거부(raise exception)가 아니라 대기열 등록이다.
    --   participations_insert_own 의 with check(아래 3번)가 'waitlisted'도 허용하도록 함께 넓어졌다 —
    --   이 줄만 바꾸고 정책은 그대로 뒀다면 with check 가 이 값을 42501 로 막아 학생이 "권한 오류"를
    --   보게 된다. 두 변경은 반드시 짝이다.
    new.status := 'waitlisted';
  end if;

  return new;
end;
$$;

comment on function public.participations_capacity_guard() is
  '[ADR 0006 + ADR 0016] 프로그램 정원 게이트. capacity NULL이면 무제한. 차 있으면 예전에는 거부했지만 '
  '이제는 status를 waitlisted로 바꿔 통과시킨다(신청 자체는 항상 성공한다 — 결과가 applied냐 waitlisted냐만 '
  '갈린다). status 무관 카운트(applied/entered/completed/waitlisted 전부 센다)와 for update 잠금(동시성 '
  '방어)은 ADR 0006 그대로. [before insert만] update에는 걸리지 않는다 — QR 인증 경로는 여전히 무관하다.';

-- =========================================================
-- 3. participations_insert_own 재정의 — status 절만 넓힌다
--
-- [학생이 waitlisted를 직접 심을 수 없다 — 이 완화가 안전한 이유]
--   컬럼 단위 grant가 여전히 insert (student_id, program_id) 뿐이다(ADR 0005 결정 6-2, 이 마이그레이션이
--   건드리지 않는다). 학생은 status 컬럼 자체를 지정할 수 없고, DB default('applied')와 위 트리거만이
--   이 컬럼에 값을 채운다. 즉 'waitlisted'가 나오는 유일한 경로는 "정원이 실제로 찼을 때 트리거가
--   판정한 결과"뿐이다 — with check를 넓혀도 학생이 스스로 대기열을 건너뛰거나 골라 들어갈 수 없다.
-- [다른 8개 절은 SQL 한 글자도 안 바뀐다] entry_at/exit_at/토큰 4종 is null, not is_admin(), 게시 여부
--   서브쿼리 — ADR 0005가 "이 마이그레이션 최대의 보안 항목"이라 부른 not is_admin() 포함, 전부 그대로.
-- =========================================================
drop policy if exists "participations_insert_own" on public.participations;

create policy "participations_insert_own"
  on public.participations
  for insert
  to authenticated
  with check (
    student_id = auth.uid()
    and not public.is_admin()
    and status in ('applied', 'waitlisted')  -- [ADR 0016] 'applied' 단독 -> 이 값 공간으로 확장
    and entry_at is null
    and exit_at is null
    and entry_token is null
    and exit_token is null
    and entry_token_expires_at is null
    and exit_token_expires_at is null
    and exists (
      select 1
      from public.programs p
      where p.id = participations.program_id
        and p.is_published = true
    )
  );

comment on policy "participations_insert_own" on public.participations is
  '[ADR 0005 + ADR 0006 + ADR 0016] 학생이 참여를 신청하는 유일한 직접 경로. status 절은 이제 '
  '(applied, waitlisted) 둘을 허용한다 — 어느 값이 되는지는 participations_capacity_guard 트리거가 '
  '정하고 학생은 고를 수 없다(컬럼 단위 grant가 student_id/program_id뿐이라 status를 직접 못 보낸다). '
  'not public.is_admin()(관리자 무한 적립 폐루프 차단)을 포함한 나머지 8절은 ADR 0005 그대로다.';

-- =========================================================
-- 4. cancel_my_participation() — 취소 + 대기열 승격
--
-- [RPC 권한 경계] cancel_my_participation(p_participation_id uuid)
--   호출 가능: authenticated. 본문에서 본인 소유인지 다시 검사한다(다른 RPC들과 동일 패턴).
--   허용 대상: student_id = auth.uid() 인 본인 참여 건만.
--   쓰는 테이블: participations(delete 1행) + 승격 시 participations(update 1행, status만).
--   불가능: 남의 참여 취소, entered/completed 참여 취소(이미 시작·완료된 활동), 시작일 당일 이후 취소.
--
-- [왜 RLS delete 정책이 아니라 RPC인가] ADR 0006 결정 1-3이 "취소·대기열이 생기면 RPC 이관을
--   재검토한다"고 예고한 지점이 이것이다. 순수 delete라면 정책으로 표현할 수 있었겠지만, 취소가
--   "정원 여유를 만들고 그 여유를 대기 1번에게 넘기는" 2단계 동작이라 원자성이 필요하다(결정 2-2와
--   같은 사유 — RLS는 여러 테이블/행에 걸친 원자적 부수효과를 표현할 수 없다).
-- [날짜 판정 — "시작 전날까지"] 오늘이 프로그램 date보다 이르면(= 아직 시작 전날까지) 취소할 수 있다.
--   당일(today = date)부터는 막는다. 기간제도 date(시작일) 기준 — 시작한 뒤의 "취소"는 이미 뜻이
--   달라진다(참여를 중도 포기하는 것이지 신청을 무른 것이 아니다. 이번 스코프가 아니다).
-- [승격 대상 선택] 그 프로그램의 waitlisted 중 created_at이 가장 이른 1명 — 신청한 순서를 그대로
--   지킨다(선착순 대기열). for update로 잠가 동시 취소 2건이 같은 대기자를 중복 승격시키지 않는다.
-- [승격이 필요 없는 경우] 취소한 행 자체가 waitlisted였다면(대기 중이던 사람이 대기를 포기) 정원에
--   여유가 생기지 않는다 — 이미 자리가 없던 사람이 빠진 것뿐이다. applied였을 때만 승격을 시도한다.
-- =========================================================
create or replace function public.cancel_my_participation(p_participation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student  uuid := auth.uid();
  v_p        public.participations%rowtype;
  v_prog     public.programs%rowtype;
  v_promoted boolean := false;
  v_next     uuid;
  v_rows     integer;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;

  select * into v_p
    from public.participations
   where id = p_participation_id
     and student_id = v_student
   for update;
  if not found then
    raise exception '본인의 참여 건이 아닙니다.' using errcode = '42501';
  end if;

  if v_p.status not in ('applied', 'waitlisted') then
    -- 이미 입장 이후(entered/completed)면 "신청 취소"의 대상이 아니다 — 참여가 이미 시작됐다.
    return jsonb_build_object('ok', false, 'reason', 'already_started');
  end if;

  select * into v_prog from public.programs where id = v_p.program_id;
  if not found then
    -- 프로그램 행이 사라지는 경로는 없지만(delete 정책 0개), 방어적으로 처리한다.
    raise exception '프로그램 정보를 찾을 수 없습니다.' using errcode = '22023';
  end if;

  if public.today_kst() >= v_prog.date then
    return jsonb_build_object('ok', false, 'reason', 'too_late');
  end if;

  delete from public.participations where id = v_p.id;

  -- [승격] 방금 지운 행이 자리를 갖고 있었을 때만(applied). waitlisted였다면 자리는 원래도 없었다.
  if v_p.status = 'applied' and v_prog.capacity is not null then
    select id into v_next
      from public.participations
     where program_id = v_p.program_id
       and status = 'waitlisted'
     order by created_at asc
     limit 1
     for update;

    if v_next is not null then
      update public.participations
         set status = 'applied'
       where id = v_next
         and status = 'waitlisted'; -- CAS: 동시 취소 2건이 같은 대기자를 중복 승격시키지 않는다
      get diagnostics v_rows = row_count;
      v_promoted := (v_rows = 1);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'promoted', coalesce(v_promoted, false));
end;
$$;

comment on function public.cancel_my_participation(uuid) is
  '[ADR 0016] 학생 본인의 참여 신청 취소. 프로그램 시작일 전날까지만 가능(오늘 >= date면 too_late).
   applied/waitlisted만 취소 대상이고 entered/completed는 already_started로 거부한다. 취소한 행이
   applied(자리 보유)였고 정원이 있으면, 그 프로그램의 waitlisted 중 가장 먼저 신청한 1명을 applied로
   승격한다(선착순, for update로 중복 승격 방지). participations에 update/delete 정책이 여전히 0개라
   이 함수가 유일한 취소·승격 경로다.';

revoke all on function public.cancel_my_participation(uuid) from public;
grant execute on function public.cancel_my_participation(uuid) to authenticated;

-- =========================================================
-- 5. program_applicant_counts() — 프로그램별 확정 인원 수만 공개
--
-- [ADR 0006 결정 6을 이 지점에서만 되돌린다] "찼다 1비트만" 원칙을 "확정 인원 수"까지 넓힌다.
--   여전히 담지 않는 것: 신청자 명단·이름·학번(ADR 0005 결정 7-2(d)는 유지 — "몇 명"과 "누가"는 다른 결정이다),
--   waitlisted 인원 수(별도로 노출하지 않는다 — 필요해지면 그때 확정한다).
-- [확정 인원 = applied/entered/completed] waitlisted는 세지 않는다 — "정원 10명 중 8명"의 8은
--   실제로 자리를 차지한 사람 수여야 뜻이 맞는다. capacity_guard 트리거의 카운트(status 무관, F-2)와
--   다른 목적의 다른 카운트다 — 저건 "다음 신청이 자리 안에 드는가", 이건 "지금 자리가 몇 개 찼는가"다.
-- [security definer] participations_select_own은 본인 행만 보여준다 — invoker로 만들면 이 함수도
--   capacity_guard와 같은 이유로 자기 자신만 세게 된다(fail-open과 반대 방향이지만 결과는 똑같이 무의미).
-- =========================================================
create or replace function public.program_applicant_counts()
returns table(program_id uuid, applicant_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select pa.program_id, count(*)::integer
    from public.participations pa
   where pa.status in ('applied', 'entered', 'completed')
   group by pa.program_id;
$$;

comment on function public.program_applicant_counts() is
  '[ADR 0016] 프로그램별 확정 신청 인원 수(applied+entered+completed, waitlisted 제외). program_id와
   숫자만 반환한다 — 학생 이름·학번·명단은 어떤 경로로도 나가지 않는다(ADR 0005 결정 7-2(d) 유지).
   0건인 프로그램은 결과에 아예 나타나지 않는다(group by) — 프런트가 없는 program_id를 0으로 취급할 것.
   security definer인 이유는 participations_select_own(본인 행만)에 걸리지 않고 전체를 세기 위해서다.';

revoke all on function public.program_applicant_counts() from public;
grant execute on function public.program_applicant_counts() to authenticated;

-- =========================================================
-- 6. sync_my_notices() 재정의 — waitlisted가 (3-기간제) upcoming에 잘못 걸리던 것 보정
--
-- [바뀐 부분] 20260810140000판의 (3-기간제) 블록만 고친다. pa.status <> 'completed' 는 waitlisted도
--   통과시켜 버렸다 — 대기 중인 학생에게 "내일 참여 예정이에요"는 사실이 아니다(자리가 없다).
--   in ('applied','entered') 로 좁혀 확정된 참여만 대상으로 한다. 다른 세 조건(stale/upcoming_admin/
--   단일 일자 upcoming/exit_due 둘)은 원래도 waitlisted와 무관했다 — status='applied' 단일 비교였던
--   단일 일자 upcoming은 waitlisted를 애초에 안 걸렀었다(원래도 정확했다). 그대로 둔다.
-- =========================================================
create or replace function public.sync_my_notices()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_today    date;
  v_tomorrow date;
  v_total    integer := 0;
  v_n        integer;
begin
  if v_me is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  v_today    := public.today_kst();
  v_tomorrow := v_today + 1;

  if public.is_admin() then
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'stale', '일정이 지난 프로그램이 있어요',
           p.title || ' · ' || to_char(coalesce(p.end_date, p.date), 'MM월 DD일') || ' 종료 · 내려도 괜찮아요',
           p.id
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and coalesce(p.end_date, p.date) < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'upcoming_admin', '내일 진행하는 프로그램이 있어요',
           p.title || coalesce(' · ' || p.time, '') || ' · QR 스캔을 준비해 주세요',
           p.id
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and (
         (p.end_date is null and p.date = v_tomorrow)
         or (p.end_date is not null and v_tomorrow = any(p.session_dates))
       )
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

  else
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'applied'
       and p.date = v_tomorrow
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (3-기간제) [바뀐 부분 — ADR 0016] waitlisted 는 확정된 자리가 아니므로 제외한다.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is not null
       and pa.status in ('applied', 'entered')
       and v_tomorrow = any(p.session_dates)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'entered'
       and p.date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select distinct pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id
      from public.attendance_sessions asess
      join public.participations pa on pa.id = asess.participation_id
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and asess.status = 'entered'
       and asess.session_date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end if;

  return v_total;
end;
$$;

comment on function public.sync_my_notices() is
  '[ADR 0013 + 기간제 대응(20260810140000) + waitlisted 보정(20260810180000/ADR 0016)] 상태형 알림을 '
  '한 곳에서 만든다. 관리자: stale + upcoming_admin. 학생: upcoming(applied/entered 확정 참여만 — '
  'waitlisted 제외) + exit_due. 날짜 기준은 public.today_kst() 로 통일했다. '
  '[멱등] notifications_once_per_program_idx + on conflict do nothing. '
  '[★ definer 라 RLS 우회 — 모든 where 절의 v_me 조건을 지우지 말 것] 지우면 전교생 알림 생성기가 된다.';

revoke all on function public.sync_my_notices() from public;
grant execute on function public.sync_my_notices() to authenticated;

-- =========================================================
-- 7. issue_attendance_qr() 재정의 — waitlisted 참여의 기간제 QR 발급 구멍을 막는다
--
-- [발견 경위] 프런트(QrCenterModal)가 waitlisted 항목을 목록에서 빼는 것과는 별개 문제다 — 이 함수는
--   RPC라 학생이 자기 participation_id(자기 것이므로 당연히 안다)를 들고 직접 호출할 수 있다.
--   프런트 필터는 UI를 깨끗하게 할 뿐 권한 경계가 아니다(다른 모든 RPC와 같은 원칙 — ADR 0005).
-- [원래 있던 구멍] 20260809180000판은 `if v_p.status = 'completed' then ... end if;` 하나만 걸렀다.
--   waitlisted는 completed가 아니므로 통과하고, 그 뒤로는 session_dates/attendance_sessions만
--   본다 — 대기 중인 학생이 오늘이 진행일이기만 하면 attendance_sessions 행을 만들고 진짜 입장 QR을
--   받을 수 있었다. 단일 일자용 issue_participation_qr은 애초에 `status <> 'applied'`를 걸러 이
--   문제가 없다(462번째 줄 — entry는 applied만, exit는 entered만). 기간제만 그 대칭 검사가 빠졌었다.
-- [고친 부분] "completed"와 "그 외 무효 상태" 두 줄로 나눈다. applied/entered만 통과한다 —
--   waitlisted는 여기서 wrong_order로 막힌다(entered인데 exit를 요청하는 정상 흐름은 그대로 통과).
--   이 아래 로직(session_dates·attendance_sessions 검사)은 한 글자도 바꾸지 않는다.
-- =========================================================
create or replace function public.issue_attendance_qr(p_participation_id uuid, p_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
  v_today   date := current_date;
  v_sess    public.attendance_sessions%rowtype;
  v_token   text;
  v_expires timestamptz;
  v_try     integer := 0;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('entry', 'exit') then
    raise exception '토큰 종류는 entry 또는 exit 여야 합니다.' using errcode = '22023';
  end if;

  select * into v_p
    from public.participations
   where id = p_participation_id
     and student_id = v_student
   for update;
  if not found then
    raise exception '본인의 참여 건이 아닙니다.' using errcode = '42501';
  end if;

  select * into v_prog from public.programs where id = v_p.program_id;
  if not found or v_prog.end_date is null then
    return jsonb_build_object('ok', false, 'reason', 'not_period_program');
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  -- [ADR 0016 — 새로 추가된 줄] waitlisted는 확정된 자리가 없다. 여기서 막지 않으면 아래 로직이
  -- "오늘 세션이 있는가"만 보고 attendance_sessions 행을 만들어 준다 — 정원 게이트를 무력화한다.
  if v_p.status <> 'applied' and v_p.status <> 'entered' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;

  if not (v_today = any(v_prog.session_dates)) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_session_day');
  end if;

  select * into v_sess
    from public.attendance_sessions
   where participation_id = v_p.id and session_date = v_today
   for update;

  if not found then
    if p_type = 'exit' then
      return jsonb_build_object('ok', false, 'reason', 'wrong_order');
    end if;
    insert into public.attendance_sessions (participation_id, session_date)
    values (v_p.id, v_today)
    returning * into v_sess;
  end if;

  if v_sess.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  if p_type = 'entry' and v_sess.status <> 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if p_type = 'exit' and v_sess.status <> 'entered' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;

  loop
    v_try := v_try + 1;
    v_token := public.qr_generate_token();
    exit when not exists (
      select 1 from public.participations where entry_token = v_token or exit_token = v_token
      union all
      select 1 from public.attendance_sessions where entry_token = v_token or exit_token = v_token
    );
    if v_try >= 5 then
      raise exception '토큰 생성에 실패했습니다.' using errcode = '55000';
    end if;
  end loop;

  v_expires := now() + interval '30 minutes';

  if p_type = 'entry' then
    update public.attendance_sessions
       set entry_token = v_token, entry_token_expires_at = v_expires
     where id = v_sess.id;
  else
    update public.attendance_sessions
       set exit_token = v_token, exit_token_expires_at = v_expires
     where id = v_sess.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'participation_id', v_p.id,
    'session_date', v_today,
    'type', p_type,
    'token', v_token,
    'expires_at', v_expires
  );
end;
$$;

comment on function public.issue_attendance_qr(uuid, text) is
  '학생 본인의 "오늘" 출석 세션 QR 토큰 발급(30분 만료, 호출마다 재발급). [20260809180000] 발급 가능 여부는
   date~end_date 범위가 아니라 programs.session_dates 에 오늘이 포함되는가로 판정한다 — 주말만/평일만/
   격일/특정요일 등 관리자가 고른 진행일에만 QR이 뜬다. [ADR 0016, 20260810180000] status가 applied나
   entered일 때만 통과한다 — waitlisted(대기 중, 자리 미확정)는 wrong_order로 거부한다. 이 함수는 참여
   전체 status를 전진시키지 않는다(발급은 관리자 스캔과 무관하게 여러 번 가능해야 하므로). 대상 날짜는
   인자로 받지 않고 서버가 current_date 로 계산한다.';

revoke all on function public.issue_attendance_qr(uuid, text) from public;
grant execute on function public.issue_attendance_qr(uuid, text) to authenticated;

-- =========================================================
-- 적용 후 확인 (anon 키 + 실제 계정으로)
--   1) 정원 1짜리 프로그램 등록 -> 학생 A 신청(applied) -> 학생 B 신청 -> B는 waitlisted로 성공(거부 아님)
--   2) A가 취소(시작 전날까지) -> B가 자동으로 applied 로 승격
--   3) B가 승격된 뒤 QR 센터에 입장 QR 버튼이 뜨는지(= 발급 가능)
--   4) waitlisted 상태에서는 QR 센터에 아무 버튼도 안 뜨는지(프런트 필터) + issue_attendance_qr을
--      waitlisted participation_id로 직접 호출해도 wrong_order로 거부되는지(서버 경계 — 7번)
--   5) 프로그램 시작 당일/이후에는 취소 시도 -> too_late
--   6) entered/completed 참여 취소 시도 -> already_started
--   7) program_applicant_counts() 호출 -> 이름/학번 없이 program_id+count만 나오는지
-- =========================================================
