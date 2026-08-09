-- Accumu v2 — 마이그레이션: 기간제 프로그램의 포인트 지급 방식 3종
-- 배경(케빈): "기간제에서 한 번 참석할 때마다 포인트를 받는 프로그램이랑 전체 수강을 다 해야 포인트를
--   받는 프로그램이 나뉘면 좋겠다. 아니면 기간중 몇일 이상 참여해야 포인트처럼."
--   -> 3가지 다 만들기로 확정. 관리자가 프로그램 등록 폼에서 고른다.
--
-- [이 마이그레이션이 20260809140000 위에 얹히는 이유] 그 마이그레이션이 만든 기간제/일별 출석 구조
--   (programs.end_date, attendance_sessions, issue_attendance_qr)는 그대로 두고 "퇴장 시 언제·몇 번
--   지급하는가"만 바꾼다. issue_attendance_qr은 지급 방식과 무관하게 동일하므로 수정하지 않는다.
--
-- 범위:
--   1) 타입 1종: attendance_payout_mode ('full'/'per_session'/'threshold')
--   2) programs: attendance_payout_mode + min_attendance_days 컬럼 + 제약 5개
--   3) point_transactions: related_attendance_session_id 컬럼 + unique 제약 재설계(참여당 1건 -> 세션당 1건도 허용)
--   4) verify_attendance_qr() 재정의 — 퇴장 분기를 지급 방식별로 3갈래로 나눈다
--
-- [실행 순서] 20260809140000 이후.

-- =========================================================
-- 1. attendance_payout_mode
-- =========================================================
do $$ begin
  create type attendance_payout_mode as enum ('full', 'per_session', 'threshold');
exception
  when duplicate_object then null;
end $$;

comment on type attendance_payout_mode is
  '기간제 프로그램(programs.end_date not null)의 포인트 지급 시점. full=종료일 퇴장 인증 1회(구현 기본값), '
  'per_session=출석(퇴장 인증)마다 매번, threshold=누적 출석일이 min_attendance_days에 도달한 시점 1회. '
  '단일 일자 프로그램은 이 값이 항상 NULL이다(지급은 유일한 퇴장 인증에서 일어나므로 방식을 고를 필요가 없다).';

-- =========================================================
-- 2. programs — 컬럼 2개 + 제약 5개
-- =========================================================
alter table public.programs add column attendance_payout_mode attendance_payout_mode;
alter table public.programs add column min_attendance_days integer;

-- [백필이 제약보다 먼저다] 20260809140000 이후 이미 만들어진 기간제 프로그램은 attendance_payout_mode 가
--   NULL인 채로 존재한다. 그 시절의 유일한 동작이 "종료일 퇴장 1회 지급"이었으므로 'full'로 채운다 —
--   이 값을 바꾸면 이미 시연에 쓰인 프로그램의 지급 시점이 조용히 바뀌는 셈이라 반드시 명시적으로 맞춰준다.
update public.programs set attendance_payout_mode = 'full' where end_date is not null and attendance_payout_mode is null;

alter table public.programs
  add constraint programs_payout_mode_requires_period
    check (attendance_payout_mode is null or end_date is not null);
alter table public.programs
  add constraint programs_period_requires_payout_mode
    check (end_date is null or attendance_payout_mode is not null);
alter table public.programs
  add constraint programs_min_days_requires_threshold
    check (min_attendance_days is null or attendance_payout_mode = 'threshold');
alter table public.programs
  add constraint programs_threshold_requires_min_days
    check (attendance_payout_mode <> 'threshold' or min_attendance_days is not null);
-- [범위] 0일 이하나 프로그램 전체 일수보다 큰 값은 도달 불가능한 목표라 의미가 없다.
--   end_date - date 는 Postgres date 뺄셈이라 정수(일수 차이)를 준다 — +1은 시작일 포함.
alter table public.programs
  add constraint programs_min_days_range
    check (min_attendance_days is null or (min_attendance_days > 0 and min_attendance_days <= (end_date - date + 1)));

comment on column public.programs.attendance_payout_mode is
  '기간제 프로그램의 지급 방식(attendance_payout_mode 참고). 관리자 폼의 "포인트 지급 방식" 선택이 이 값을 채운다. '
  '단일 일자 프로그램(end_date is null)이면 반드시 NULL, 기간제면 반드시 NOT NULL — 두 제약이 서로 반대 방향으로 강제한다.';
comment on column public.programs.min_attendance_days is
  'attendance_payout_mode = ''threshold'' 일 때만 의미가 있다(그 외엔 반드시 NULL). '
  '누적 출석(퇴장 인증 완료) 일수가 이 값에 도달한 "그 퇴장"에서 참여 전체가 완료되고 포인트가 1회 지급된다. '
  '종료일까지 채우지 못하면 참여는 completed 로 전이되지 않는다(포인트도 지급되지 않는다) — 원칙 1: 진행률을 '
  '화면에 노출하지 않지만, 이 값 자체가 미달성 상태를 만들 수 있다는 것은 관리자가 알고 있어야 한다.';

-- =========================================================
-- 3. point_transactions — 회차 단위 지급을 위한 컬럼 + unique 제약 재설계
--
-- [기존 unique(related_participation_id)를 그대로 둘 수 없는 이유]
--   ADR 0005는 "참여당 적립 정확히 1건"을 이 제약으로 강제했다 — 그 전제가 "지급은 참여당 한 번뿐"이었기
--   때문이다. per_session 모드는 그 전제를 깬다: 참여 1건에 날짜 수만큼 지급이 일어나야 한다. 제약을
--   완전히 없애면 다른 모드(full/threshold/단일 일자)의 이중 지급 방어가 사라진다 — 그래서 조건부(partial)
--   unique 인덱스 2개로 나눈다: "세션에 안 묶인 지급(참여 단위)"은 참여당 1건, "세션에 묶인 지급(회차 단위)"은
--   세션당 1건. 두 방어가 서로 다른 축을 막으므로 어느 쪽도 느슨해지지 않는다.
-- =========================================================
alter table public.point_transactions
  add column related_attendance_session_id uuid references public.attendance_sessions(id) on delete cascade;

alter table public.point_transactions
  drop constraint point_transactions_participation_unique;

-- 참여 단위 적립(단일 일자 프로그램 전체 + 기간제 full/threshold 모드) — 참여당 최대 1건.
create unique index point_transactions_participation_unique_idx
  on public.point_transactions (related_participation_id)
  where related_attendance_session_id is null;

-- 회차 단위 적립(기간제 per_session 모드) — 같은 세션(그 날의 출석)에 대한 재지급만 막는다.
--   같은 참여가 여러 날 값을 가지는 것은 이 모드의 정상 동작이므로 참여 단위로는 막지 않는다.
create unique index point_transactions_session_unique_idx
  on public.point_transactions (related_attendance_session_id)
  where related_attendance_session_id is not null;

comment on column public.point_transactions.related_attendance_session_id is
  '기간제 per_session 모드에서만 채워진다(그 외 모드/단일 일자는 NULL). 어느 날짜의 출석에 대한 지급인지를 '
  '가리키며, related_participation_id 는 이 경우에도 함께 채워진다(둘 다 NULL이 아닌 행 = 회차 지급). '
  'point_transactions_session_unique_idx 가 "그 날 재지급"만 막고 참여 전체의 지급 건수는 제한하지 않는다.';
comment on table public.point_transactions is
  '포인트 적립/전환 원장 (CLAUDE.md 5장). 적립은 public.verify_participation_qr()(단일 일자) 또는 '
  'public.verify_attendance_qr()(기간제)의 퇴장 인증 성공 시 생성된다 — 후자는 지급 방식(full/per_session/'
  'threshold)에 따라 참여당 1건이거나 날짜 수만큼 여러 건일 수 있다(위 unique 인덱스 2개가 각각의 이중 지급을 '
  '막는다). 전환(포인트 -> 지역화폐 시뮬레이션)은 마이페이지 스펙 몫이며 이를 생성하는 코드가 없다. '
  '[RLS] point_transactions_select_own 이 학생 본인 행을 연다(ADR 0007) — 그 외 정책 0개.';

-- =========================================================
-- 4. verify_attendance_qr() 재정의 — 퇴장 분기를 지급 방식 3갈래로 나눈다
--
-- [입장 분기는 20260809140000과 완전히 동일하다] 지급 방식은 퇴장(= 완료 판정)에만 영향을 준다.
-- [권한 경계·검사 순서·반환 사유 체계는 그대로다] verify_participation_qr / 20260809140000판 verify_attendance_qr
--   과 동일한 규율을 따른다. 아래 주석은 이번에 바뀐 퇴장 로직에만 집중한다.
-- =========================================================
create or replace function public.verify_attendance_qr(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin         uuid := auth.uid();
  v_token         text;
  v_kind          text;
  v_sess          public.attendance_sessions%rowtype;
  v_p             public.participations%rowtype;
  v_prog          public.programs%rowtype;
  v_name          text;
  v_base          jsonb;
  v_rows          integer;
  v_points        integer;
  v_now           timestamptz := now();
  v_mode          public.attendance_payout_mode;
  v_is_final      boolean;
  v_completed_days integer;
begin
  if v_admin is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception '관리자만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  v_token := public.qr_normalize_token(p_token);
  if length(v_token) <> 10 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_sess from public.attendance_sessions where entry_token = v_token for update;
  if found then
    v_kind := 'entry';
  else
    select * into v_sess from public.attendance_sessions where exit_token = v_token for update;
    if found then
      v_kind := 'exit';
    end if;
  end if;

  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_p from public.participations where id = v_sess.participation_id;
  select * into v_prog from public.programs where id = v_p.program_id;
  if not found or v_prog.created_by is null or v_prog.created_by <> v_admin then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  select p.name into v_name from public.profiles p where p.id = v_p.student_id;
  v_base := jsonb_build_object(
    'type', v_kind, 'student_name', v_name, 'program_title', v_prog.title,
    'session_date', v_sess.session_date
  );

  if v_sess.status = 'completed' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  if v_kind = 'entry' then
    -- [입장 — 지급 방식과 무관, 20260809140000과 동일]
    if v_sess.status <> 'applied' then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;
    if v_sess.entry_token_expires_at is null or v_sess.entry_token_expires_at <= v_now then
      return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
    end if;

    update public.attendance_sessions
       set status = 'entered', entry_at = v_now
     where id = v_sess.id
       and status = 'applied';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;

    update public.participations
       set status = 'entered', entry_at = coalesce(entry_at, v_now)
     where id = v_p.id
       and status = 'applied';

    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
  end if;

  -- v_kind = 'exit' — 여기부터 지급 방식별로 갈린다.
  if v_sess.status = 'applied' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if v_sess.exit_token_expires_at is null or v_sess.exit_token_expires_at <= v_now then
    return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- 그날 출석 확정은 방식과 무관하게 공통이다.
  update public.attendance_sessions
     set status = 'completed', exit_at = v_now
   where id = v_sess.id
     and status = 'entered';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  -- 레거시 방어: 이 함수가 처음 생겼을 때(20260809140000) 만들어진 기간제 행은 이번 마이그레이션의
  -- 백필로 전부 'full'이 채워졌어야 하지만, coalesce로 한 번 더 fail-safe를 둔다.
  v_mode := coalesce(v_prog.attendance_payout_mode, 'full');
  v_is_final := (v_sess.session_date = v_prog.end_date);

  if v_mode = 'per_session' then
    -- [매회 지급] 이 세션 하나에 대해 지급한다. 참여 전체 완료(=QR 흐름 종료)는 여전히 종료일에만 일어난다.
    v_points := v_prog.points;
    begin
      insert into public.point_transactions
        (student_id, type, amount, related_participation_id, related_attendance_session_id)
      values (v_p.student_id, '적립', v_points, v_p.id, v_sess.id);

      update public.profiles
         set points_balance = points_balance + v_points,
             points_total   = points_total   + v_points
       where id = v_p.student_id;
    exception
      when unique_violation then
        -- point_transactions_session_unique_idx — 동시 스캔으로 이 세션이 이미 지급된 경우. 출석 기록
        -- 자체(위 update)는 이미 성공했으니 지급 없이 성공으로 응답한다(이중 지급만 막는다).
        v_points := null;
    end;

    if v_is_final then
      update public.participations
         set status = 'completed', exit_at = v_now
       where id = v_p.id
         and status = 'entered';
    end if;

    return v_base || jsonb_build_object(
      'ok', true, 'reason', null, 'at', v_now, 'final', v_is_final, 'points_awarded', v_points
    );
  end if;

  if v_mode = 'threshold' then
    -- [최소 참여일수] 이 세션까지 포함해 누적 완료 일수를 센다(방금 위에서 completed 로 바꿨으므로 포함된다).
    select count(*) into v_completed_days
      from public.attendance_sessions
     where participation_id = v_p.id and status = 'completed';

    if v_completed_days < v_prog.min_attendance_days then
      -- 아직 도달 못함 — 그날 출석만 기록. 포인트 없음(원칙 1: 남은 일수 같은 진행률은 반환하지 않는다).
      return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
    end if;

    -- 도달 — 참여 전체 완료 + 1회 지급 (참여 단위 지급이라 related_attendance_session_id 는 NULL).
    v_points := v_prog.points;
    update public.participations
       set status = 'completed', exit_at = v_now
     where id = v_p.id
       and status = 'entered';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      -- 동시 스캔 등으로 이미 다른 요청이 완료 처리함. 이 스캔은 출석 기록은 성공했으니 성공으로 응답하되
      -- 지급 여부는 그 다른 요청이 이미 했다 — 여기서 다시 지급하면 이중 지급이 된다.
      return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
    end if;

    begin
      insert into public.point_transactions (student_id, type, amount, related_participation_id)
      values (v_p.student_id, '적립', v_points, v_p.id);

      update public.profiles
         set points_balance = points_balance + v_points,
             points_total   = points_total   + v_points
       where id = v_p.student_id;
    exception
      when unique_violation then
        return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
    end;

    return v_base || jsonb_build_object(
      'ok', true, 'reason', null, 'at', v_now, 'final', true, 'points_awarded', v_points
    );
  end if;

  -- v_mode = 'full' (기본값) — 종료일 퇴장에서만 참여 전체 완료 + 1회 지급.
  if not v_is_final then
    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
  end if;

  v_points := v_prog.points;
  begin
    update public.participations
       set status = 'completed', exit_at = v_now
     where id = v_p.id
       and status = 'entered';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
    end if;

    insert into public.point_transactions (student_id, type, amount, related_participation_id)
    values (v_p.student_id, '적립', v_points, v_p.id);

    update public.profiles
       set points_balance = points_balance + v_points,
           points_total   = points_total   + v_points
     where id = v_p.student_id;
  exception
    when unique_violation then
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end;

  return v_base || jsonb_build_object(
    'ok', true, 'reason', null, 'at', v_now, 'final', true, 'points_awarded', v_points
  );
end;
$$;

comment on function public.verify_attendance_qr(text) is
  '관리자 QR 스캔 검증(기간제 전용). 입장 분기는 지급 방식과 무관하다. 퇴장 분기는 programs.attendance_payout_mode
   에 따라 셋으로 갈린다 — full: 종료일 퇴장 1회 지급, per_session: 매 퇴장마다 지급(participations 완료는
   여전히 종료일), threshold: 누적 완료 세션 수가 min_attendance_days 에 도달한 퇴장에서 1회 지급(그 즉시
   participations 도 완료된다 — 종료일을 기다리지 않는다). 반환 final 은 "이 퇴장으로 참여 전체가 completed
   되었는가"이고, points_awarded 는 "이 퇴장에서 실제로 지급됐는가"다 — per_session 모드에서는 final=false여도
   points_awarded 가 채워질 수 있다(그 회차 지급).';

revoke all on function public.verify_attendance_qr(text) from public;
grant execute on function public.verify_attendance_qr(text) to authenticated;
