-- Accumu v2 — 마이그레이션: 기간제 프로그램 + 일별 출석 QR 인증
-- 배경: 공유학교·온라인학교처럼 하루가 아니라 여러 날에 걸쳐 진행되는 프로그램이 있다. 관리자가 등록 시
--   "기간제"를 선택하면 시작일(programs.date)~종료일(programs.end_date)을 갖고, 학생은 그 기간의 날짜마다
--   입장·퇴장 QR을 따로 인증한다 — 절대 원칙 5(QR 단순화 금지)를 매일 단위로 적용한 것이다.
--   최종 완료(포인트 지급)는 여전히 "퇴장 인증 1회"에서 일어난다 — 다만 그 1회가 종료일의 퇴장이다.
--
-- [기존 마이그레이션을 건드리지 않는다] 20260723120000 이 만든 participations 컬럼/함수
--   (issue_participation_qr / verify_participation_qr)는 그대로 둔다. 단일 일자 프로그램
--   (programs.end_date is null)은 100% 기존 경로 그대로 동작한다. 기간제 프로그램만 이 파일이 추가하는
--   새 테이블(attendance_sessions)과 새 함수 2개를 탄다 — 왜 참여 자체를 이 테이블로 옮기지 않았는가는
--   아래 2번 절 주석 참고.
--
-- 범위:
--   1) programs.end_date 컬럼(nullable) + range 체크 제약
--   2) attendance_sessions 테이블(참여 1건의 날짜별 출석) + RLS 정책 1개(select_own)
--   3) 함수 2개: issue_attendance_qr(학생 발급) / verify_attendance_qr(관리자 검증 + 종료일이면 참여 완료·포인트 지급)
--
-- [실행 순서] 기존 마이그레이션 전부(특히 20260723120000) 적용 이후. 이 파일이 참조하는
--   public.is_admin() / public.qr_normalize_token() / public.qr_generate_token() / point_transactions /
--   participation_status 는 전부 그 마이그레이션이 이미 만들어 두었다.
--
-- [재실행] add column / add constraint / create policy 에 가드가 없어 두 번째 적용 시 실패한다
--   (기존 마이그레이션들과 동일한 관례. 1회 적용 전제).

-- =========================================================
-- 1. programs.end_date
-- =========================================================
alter table public.programs add column end_date date;

alter table public.programs
  add constraint programs_end_date_after_start check (end_date is null or end_date >= date);

comment on column public.programs.end_date is
  '[기간제 프로그램 — 신규] NULL = 단일 일자 프로그램(기존 동작 그대로, date 하루). '
  'NOT NULL = 기간제로, date(시작일)~end_date(종료일) 동안 매일 attendance_sessions 를 통해 입·퇴장 QR '
  '인증이 필요하다. 종료일 퇴장 인증 시점에 포인트가 지급된다 — 단일 일자 프로그램의 '
  '"퇴장 인증 = 지급" 규칙(ADR 0005)을 그대로 잇는다. 관리자 폼의 "기간제 프로그램" 체크박스가 이 값을 채운다.';

-- =========================================================
-- 2. attendance_sessions — 기간제 프로그램의 날짜별 출석
--
-- [participations 를 복제하지 않는다 — 왜 별도 테이블인가]
--   참여 자체(신청/최종 완료/포인트/리뷰 대상)는 여전히 participations 1행이 소유한다. 이 테이블은
--   그 참여의 "날짜별 부속 기록"일 뿐이다. 만약 participations 를 날짜 수만큼 여러 행으로 쪼갰다면
--   point_transactions.related_participation_id unique 제약(참여당 적립 1건)이 깨지고, 아카이브가
--   프로그램 1건을 여러 카드로 보여주는 회귀가 생긴다.
--   [열 이름을 participations 와 똑같이 맞춘 이유] status/entry_at/exit_at/토큰 4쌍의 모양을 그대로 재사용해
--   issue_participation_qr / verify_participation_qr 의 검증된 패턴(CAS, 1회용 토큰, 만료)을 그대로 베낄 수
--   있게 했다 — 날짜별 버전을 처음부터 다시 설계하지 않는다.
-- =========================================================
create table if not exists public.attendance_sessions (
  id                      uuid primary key default gen_random_uuid(),
  participation_id        uuid not null references public.participations(id) on delete cascade,
  session_date            date not null,
  status                  participation_status not null default 'applied', -- applied(발급 전)/entered(입장)/completed(그날 출석 완료)
  entry_at                timestamptz,
  exit_at                 timestamptz,
  entry_token             text,
  exit_token              text,
  entry_token_expires_at  timestamptz,
  exit_token_expires_at   timestamptz,
  created_at              timestamptz not null default now(),

  -- 참여 1건당 하루 1행. issue_attendance_qr() 이 "오늘" 행이 없으면 만들고 있으면 재사용한다.
  constraint attendance_sessions_unique unique (participation_id, session_date),
  constraint attendance_sessions_entry_token_unique unique (entry_token),
  constraint attendance_sessions_exit_token_unique  unique (exit_token)
);

comment on table public.attendance_sessions is
  '기간제 프로그램(programs.end_date not null)의 날짜별 출석 기록. 참여 1건당 최대 (end_date-date+1)행. '
  '단일 일자 프로그램은 이 테이블에 행이 생기지 않는다 — 기존 participations 4컬럼(entry_at 등)만 쓴다. '
  '[시연 리셋] participations 를 지우면 on delete cascade 로 이 테이블도 함께 지워진다 — 별도 delete 문 불필요.';
comment on column public.attendance_sessions.session_date is
  '서버가 issue_attendance_qr() 안에서 current_date 로 계산해 채운다. 클라이언트가 날짜를 골라 보낼 수 없다 '
  '— 보낼 수 있게 하면 학생이 임의의 날짜를 "출석한 날"로 지정할 수 있게 된다.';

alter table public.attendance_sessions enable row level security;

-- [RLS 권한 경계] attendance_sessions_select_own
--   대상 역할: authenticated (학생 본인)
--   허용 행: participation_id 가 가리키는 participations.student_id = auth.uid() 인 행만
--   용도: 학생 QR 센터의 "오늘 세션" 및 지난 출석 기록 표시
--   불가능: 남의 출석 기록 조회, 관리자의 조회(정책 대상이 아니다).
--   [관리자에게 select 를 열지 않는 이유] 담당 학생 아카이브는 참여 단위(완료 여부)만 보여준다(원칙 6).
--   날짜별 출석 로그까지 노출하면 "출석 관리"라는 4번째 관리자 기능이 생긴다. 관리자는 검증 시점에
--   verify_attendance_qr() 의 반환값(그 한 건의 학생 이름·날짜)만 본다 — 목록 조회 권한은 열지 않는다.
create policy "attendance_sessions_select_own"
  on public.attendance_sessions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.participations p
      where p.id = attendance_sessions.participation_id
        and p.student_id = auth.uid()
    )
  );

-- insert/update/delete 정책 0개 — participations 와 동일한 원칙(ADR 0005 결정 2). 쓰기는 아래
-- security definer 함수 2개만 수행한다.

-- =========================================================
-- 3. issue_attendance_qr() — 학생 본인의 "오늘" 세션 토큰 발급
--
-- [RPC 권한 경계] issue_attendance_qr(p_participation_id uuid, p_type text)
--   호출 가능: authenticated (본문에서 본인 참여 건인지 다시 검사)
--   대상 날짜: 서버가 계산하는 current_date 하나뿐이다. 클라이언트는 어떤 날짜에 대한 토큰인지 고를 수
--     없다 — issue_participation_qr 이 상태를 안 바꾸는 것과 같은 이유로, "학생이 원하는 날짜를 스스로
--     골라 출석 처리"하는 경로를 원천 차단한다.
--   [타임존 주의] current_date 는 DB 세션 타임존(Supabase 기본 UTC) 기준이라 KST 자정 전후 9시간 구간에서
--     "오늘"이 하루 어긋날 수 있다. 스캔은 활동 시간대(주간)에 일어나므로 이번 스코프에서는 허용한다 —
--     실제로 자정 경계 문제가 보고되면 그때 세션 타임존을 다룬다.
--   생성 조건: programs.end_date 가 not null(기간제)이고 오늘이 [date, end_date] 안에 있어야 한다.
--   >>> status/entry_at/exit_at/student_id 를 절대 쓰지 않는다 — issue_participation_qr 과 동일 원칙.
--   불가능: 남의 참여 건, 단일 일자 프로그램 호출, 기간 밖 호출, 순서 위반(그날 입장 전 퇴장 요청),
--           이미 전체 완료된 참여, 오늘 이미 완료된 세션 재요청
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

  -- 본인 행만. for update 로 잠가 동시 발급 요청을 직렬화한다 (issue_participation_qr 과 동일 패턴).
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
    -- 단일 일자 프로그램은 issue_participation_qr 을 쓴다. 여기로 잘못 오면 조용히 거부한다.
    return jsonb_build_object('ok', false, 'reason', 'not_period_program');
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  if v_today < v_prog.date or v_today > v_prog.end_date then
    return jsonb_build_object('ok', false, 'reason', 'out_of_range');
  end if;

  select * into v_sess
    from public.attendance_sessions
   where participation_id = v_p.id and session_date = v_today
   for update;

  if not found then
    if p_type = 'exit' then
      -- 오늘 입장도 안 했는데 퇴장 토큰을 요청 = 순서 위반. 행을 만들지 않고 바로 거부한다.
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

  -- 컬럼 간·테이블 간 충돌까지 막는다 (participations 토큰과도 겹치지 않아야 한다 — 검증 함수가
  -- entry_token 을 먼저 participations 에서, 없으면 attendance_sessions 에서 찾기 때문).
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

  v_expires := now() + interval '30 minutes'; -- CLAUDE.md 6장과 동일한 만료 정책.

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
  '학생 본인의 "오늘" 출석 세션 QR 토큰 발급(30분 만료, 호출마다 재발급). issue_participation_qr 과 같은 규율 —
   이 함수는 status 를 전진시키지 않는다(발급은 관리자 스캔과 무관하게 여러 번 가능해야 하므로).
   대상 날짜는 인자로 받지 않고 서버가 current_date 로 계산한다.';

revoke all on function public.issue_attendance_qr(uuid, text) from public;
grant execute on function public.issue_attendance_qr(uuid, text) to authenticated;

-- =========================================================
-- 4. verify_attendance_qr() — 관리자 스캔: 일별 세션 검증 + (종료일 퇴장이면) 참여 전체 완료·포인트 지급
--
-- [RPC 권한 경계] verify_attendance_qr(p_token text)
--   호출 가능: authenticated 이면서 is_admin() 통과. 허용 대상은 verify_participation_qr 과 동일하게
--   토큰이 가리키는 참여 건의 programs.created_by = auth.uid() 인 경우만 (확정 H-1과 동일 축).
--   [인자가 토큰 하나뿐인 이유·검사 순서·반환 사유 체계는 verify_participation_qr 과 완전히 동일하다]
--   여기서 새로 추가되는 것은 하나뿐이다 — 퇴장이 성공했을 때 "이 세션이 종료일(programs.end_date)의
--   세션인가"를 판정해 참여 전체를 완료시킬지 그날 출석만 기록할지 가른다.
-- =========================================================
create or replace function public.verify_attendance_qr(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := auth.uid();
  v_token    text;
  v_kind     text;
  v_sess     public.attendance_sessions%rowtype;
  v_p        public.participations%rowtype;
  v_prog     public.programs%rowtype;
  v_name     text;
  v_base     jsonb;
  v_rows     integer;
  v_points   integer;
  v_now      timestamptz := now();
  v_is_final boolean;
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
    if v_sess.status <> 'applied' then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;
    if v_sess.entry_token_expires_at is null or v_sess.entry_token_expires_at <= v_now then
      return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
    end if;

    update public.attendance_sessions
       set status = 'entered', entry_at = v_now
     where id = v_sess.id
       and status = 'applied'; -- CAS
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;

    -- 참여 전체의 첫 입장이면(아직 applied) participations.status 도 entered 로 함께 올린다.
    -- 아카이브·QR 센터가 "참여가 시작됐는가"를 여전히 participations.status 로 판단하기 때문이다.
    -- 이미 entered/completed 면 이 update 는 0행 영향으로 조용히 끝난다(where 절이 걸러낸다).
    update public.participations
       set status = 'entered', entry_at = coalesce(entry_at, v_now)
     where id = v_p.id
       and status = 'applied';

    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
  end if;

  -- v_kind = 'exit'
  if v_sess.status = 'applied' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if v_sess.exit_token_expires_at is null or v_sess.exit_token_expires_at <= v_now then
    return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  update public.attendance_sessions
     set status = 'completed', exit_at = v_now
   where id = v_sess.id
     and status = 'entered'; -- CAS
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  v_is_final := (v_sess.session_date = v_prog.end_date);

  if not v_is_final then
    -- 마지막 날이 아니면 그날 출석만 기록한다. 참여 전체는 여전히 entered 다 — 포인트 없음.
    -- [원칙 1 가드] 여기서 "N/M일 출석" 같은 진행률을 계산해 반환하지 않는다. 그날 기록 여부만 사실이다.
    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now, 'final', false);
  end if;

  -- 종료일 퇴장 = 참여 전체 완료 + 포인트 지급. verify_participation_qr 의 퇴장 분기와 동일한 패턴
  -- (CAS + point_transactions unique 이중 방어 + 한 트랜잭션).
  v_points := v_prog.points;
  begin
    update public.participations
       set status = 'completed', exit_at = v_now
     where id = v_p.id
       and status = 'entered'; -- CAS
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
      -- 이미 적립된 참여(동시 스캔 등). 이 블록의 상태 전이까지 함께 롤백되고 포인트는 늘지 않는다.
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end;

  return v_base || jsonb_build_object(
    'ok', true, 'reason', null, 'points_awarded', v_points, 'at', v_now, 'final', true
  );
end;
$$;

comment on function public.verify_attendance_qr(text) is
  '관리자 QR 스캔 검증(기간제 프로그램 전용). verify_participation_qr 과 같은 권한 경계·반환 사유 체계를 쓴다.
   차이는 하나뿐이다 — 퇴장 성공 시 그 세션의 session_date 가 programs.end_date 와 같은 "마지막 날"이면
   participations 전체를 completed 로 전이시키고 포인트를 지급한다. 그 전 날짜의 퇴장은 그날 출석만
   기록하고 포인트는 지급하지 않는다.
   [프런트 연결] participationService.verifyQr() 이 verify_participation_qr 을 먼저 시도하고 not_found 일
   때만 이 함수를 시도한다 — 관리자 스캔 화면(AdminScanPage)은 두 종류의 토큰을 구분할 필요가 없다.';

revoke all on function public.verify_attendance_qr(text) from public;
grant execute on function public.verify_attendance_qr(text) to authenticated;
