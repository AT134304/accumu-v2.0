-- Accumu v2 — 지역화폐 월 단위 자동 정산 (ADR 0012)
-- 출처: docs/adr/0012-monthly-currency-settlement.md
--
-- [무엇이 바뀌는가]
--   전: 학생이 마이페이지에서 금액을 고르고 "지역화폐로 전환" 버튼을 눌러 즉시 전환했다
--       (convert_points_to_currency, ADR 0007 결정 3).
--   후: 학생은 전환을 실행하지 못한다. M월에 적립한 포인트 전액이 (M+1)월 말일에 자동으로 전환된다.
--       실제 제도(기후행동 기회소득 / 천권으로 독서포인트)의 "적립기간 후 일괄 지급" 방식이다.
--
-- [왜 이 방향이 원칙과 맞는가]
--   포인트를 아무 때나 현금성 자산으로 바꿀 수 있으면 활동이 아니라 포인트가 목적이 된다.
--   전환 시점을 학생 손에서 빼면 마이페이지에서 "굴릴 수 있는 것"이 사라진다(원칙 1·4).
--   절대 원칙 3 은 그대로다 — 결제/계좌/외부 API 호출이 여전히 0줄이고 currency_balance 는 표시용 숫자다.
--
-- [이 마이그레이션이 하는 일]
--   1) point_transactions: settled_month 컬럼 + unique(student_id, settled_month) + CHECK 1개
--   2) settle_my_points() 신설 (security definer, 학생 본인, 멱등)
--   3) convert_points_to_currency() 제거 — 학생 주도 전환 경로를 구조적으로 없앤다
--   재실행해도 안전하다.

-- =========================================================
-- 1. point_transactions.settled_month — "어느 달 적립분의 정산인가"
--
-- [이 컬럼 하나가 멱등성 전부다]
--   정산 함수는 학생이 화면에 들어올 때마다 호출된다(cron 이 아니다 — 아래 2번 절 참고).
--   같은 달을 두 번 정산하면 잔액이 두 번 빠진다. 그 방어를 애플리케이션 조건문이 아니라
--   unique 제약으로 표현한다 — QR 이중 지급을 unique(related_participation_id) 로 막은 것과 같은 기법이며,
--   같은 이유로 여기서도 "재시도·동시 요청·두 탭"이 전부 23505 로 튕긴다.
--
-- [nullable 로 두는 이유 — 기존 데이터 때문이다]
--   ADR 0007 시절의 수동 전환 행이 이미 있을 수 있다. 그 행들은 "어느 달 적립분"이라는 개념 자체가 없다.
--   not null 로 만들면 마이그레이션이 그 행 앞에서 실패하거나, 없는 값을 지어내야 한다.
--   NULL 은 unique 에 걸리지 않으므로 과거 행은 새 제약에 자연히 비켜선다.
-- =========================================================
alter table public.point_transactions add column if not exists settled_month date;

comment on column public.point_transactions.settled_month is
  '[type=전환 전용] 이 전환이 정산한 "적립 월"의 1일 (예: 2026-08-01 = 8월 적립분). '
  '정산 실행일이 아니다 — 실행 시각은 created_at 이고, 8월 적립분의 정산일은 9월 말일이다. '
  '[멱등성의 소유자] unique (student_id, settled_month) 가 같은 달의 두 번째 정산을 23505 로 막는다. '
  '[NULL 인 행 2종] (a) 적립 행 — 아래 CHECK 가 강제한다. (b) ADR 0007 시절의 수동 전환 행 — 월 개념이 없다.';

-- 적립 행에는 이 값이 있을 수 없다. "적립인데 어느 달 정산분" 은 뜻이 성립하지 않는다.
-- 전환 쪽을 not null 로 강제하지 않는 이유는 위 컬럼 주석의 (b) 때문이다.
do $$ begin
  alter table public.point_transactions
    add constraint point_transactions_settled_month_rule
    check (type = '전환' or settled_month is null);
exception
  when duplicate_object then null;
end $$;

-- [제약의 부산물인 인덱스는 예외] ADR 0003/0004 의 "인덱스를 추가하지 않는다" 원칙에 대해
--   unique (student_id, program_id) / unique (entry_token) 과 같은 지위다. 여기서 막는 것이 실제 사고
--   (같은 달 이중 정산 = 잔액 이중 차감)이기 때문이다.
do $$ begin
  alter table public.point_transactions
    add constraint point_transactions_settlement_unique unique (student_id, settled_month);
exception
  when duplicate_object then null;
end $$;

-- =========================================================
-- 2. settle_my_points() — 정산 실행 + 예정 목록 조회 (한 번의 왕복)
--
-- [RPC 권한 경계] settle_my_points()
--   호출 가능: authenticated. 본문에서 (a) 로그인 여부 (b) 관리자가 아님 을 검사한다.
--   허용 대상: auth.uid() 본인뿐. 인자가 0개다 = 남의 포인트를 정산할 경로가 시그니처에 없다.
--   쓰는 컬럼: profiles.points_balance / currency_balance + point_transactions 1행(월당).
--   >>> points_total 을 절대 쓰지 않는다. 누적 적립은 영구 기록이다(ADR 0005 결정 3-4).
--   >>> role / code / name / career_interest / account_type 도 이 함수의 UPDATE 문에 없다.
--   불가능: 금액 지정(인자가 없다), 남의 정산(경로 없음), 관리자 호출(42501),
--           같은 달 이중 정산(23505 — 위 unique), 잔액 음수화(조건부 UPDATE + CHECK)
--
-- [★ cron 이 아니라 지연 정산(lazy)인 이유]
--   "말일 자정에 서버가 일괄 처리" 가 제도의 그림이지만, 그러려면 pg_cron 을 켜고 스케줄을 등록해야 한다.
--   이 프로젝트에서 그것은 (a) 시연 당일 확인할 수 없는 실패 지점이 하나 늘고 (b) 실행 이력이 DB 밖에 생기고
--   (c) 로컬/원격에서 동작이 갈리는 대가를 치른다. 반면 정산 결과는 **시각이 아니라 날짜의 함수**라
--   "언제 계산하든 답이 같다" — 그러면 미리 돌려둘 이유가 없다. 학생이 화면에 들어온 순간 계산하면 된다.
--   >>> 이것이 성립하는 전제: 함수가 멱등이고(unique), 대상 선정이 now() 가 아니라 날짜 비교라는 것.
--       그 두 가지를 깨는 변경을 하지 말 것.
--
-- [월 경계는 KST 로 자른다] created_at 은 timestamptz(UTC 저장)다. UTC 로 자르면 한국 시간 9월 1일 오전 6시
--   적립이 8월분으로 들어간다. 화면이 "8월에 모은 포인트"라고 말하는 이상 경계도 한국 달력이어야 한다.
--
-- [정산일 = (적립월 + 2개월)의 1일 - 1일]  8월분 -> 2026-10-01 - 1 = 2026-09-30. 즉 "다음 달 말일".
--   말일 00:00(KST)부터 정산된다. 날짜 비교라 말일 하루 종일 같은 답이 나온다.
--
-- [반환] 정산 실행과 예정 조회를 한 함수가 함께 돌려준다. 화면이 필요한 것이 정확히 이 셋이라
--   왕복을 3번으로 쪼갤 이유가 없다(그리고 쪼개면 "정산 직후의 예정 목록"이 어긋날 수 있다).
--   { ok, settled:[{month, amount, settle_on}], pending:[{month, amount, settle_on}],
--     points_balance, points_total, currency_balance }
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
  -- (1) 호출자 신원. 학생/관리자가 같은 DB 역할(authenticated)이라 "학생만" 은 여기서만 표현된다.
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자는 참여할 수 없어 적립이 0 이다(participations_insert_own 의 not is_admin()).
    -- 포인트/지역화폐는 학생의 도메인이라는 불변식을 여기서도 명시한다(CLAUDE.md 4장).
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  v_today := (now() at time zone 'Asia/Seoul')::date;

  -- (2) 정산일이 지났는데 아직 정산되지 않은 달을 오래된 순으로 처리한다.
  --     오래된 순인 이유: 잔액이 모자라 중간에 멈추더라도 앞선 달부터 정산되는 것이 자연스럽다.
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
    -- (2-a) 잔액 이동. where points_balance >= amt 조건부 UPDATE 한 문장이 잠금이자 검사다
    --       (수동 전환 함수와 같은 규율 — 동시 요청은 READ COMMITTED 재평가로 직렬화된다).
    --       SET 목록에 points_total 이 없다. 누적 적립은 전환과 무관하게 증가만 한다.
    update public.profiles
       set points_balance   = points_balance   - v_row.amt,
           currency_balance = currency_balance + v_row.amt
     where id = v_student
       and points_balance >= v_row.amt;

    if not found then
      -- [알려진 틈 — 레거시 계정에서만 발생] 잔액이 그 달 적립액보다 적다는 뜻이고, 원인은 사실상
      --   "ADR 0007 시절의 수동 전환으로 이미 빠져나간 포인트"뿐이다(적립 외에 잔액을 늘리는 경로가 없다).
      --   금액을 깎아 부분 정산하지 않는다 — 부분 정산은 "월당 1행" 이라는 멱등성 단위를 깨뜨린다.
      --   그 달을 건너뛰면 아래 pending 목록에 계속 남아 화면에 보인다(조용히 사라지지 않는다).
      --   시연 리셋(point_transactions 삭제 + profiles.points_* 초기화)으로 해소된다.
      continue;
    end if;

    -- (2-b) 원장 1행. ★ 잔액 UPDATE 뒤에 둔다 — 순서를 바꾸면 amount > 0 CHECK 의 2차 방어가 사라진다
    --       (convert_points_to_currency 가 세운 규율 그대로).
    --       related_participation_id 는 반드시 NULL 이다(point_transactions_source_rule).
    insert into public.point_transactions (student_id, type, amount, related_participation_id, settled_month)
    values (v_student, '전환', v_row.amt, null, v_row.m);

    v_settled := v_settled || jsonb_build_object(
      'month', v_row.m, 'amount', v_row.amt, 'settle_on', v_row.settle_on
    );
  end loop;

  -- (3) 아직 전환되지 않은 달 = 정산일이 오지 않았거나 위에서 건너뛴 달.
  --     화면의 "N월 말일 전환 예정" 줄이 이 목록이다.
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

  -- (4) 최신 잔액 3종. 프런트가 profiles 를 다시 select 하는 왕복을 없앤다(전환 RPC 가 세운 규율).
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

comment on function public.settle_my_points() is
  '[ADR 0012] 지역화폐 월 단위 자동 정산. M월 적립분 전액을 (M+1)월 말일에 전환한다(기후행동 기회소득 / '
  '천권으로 독서포인트와 같은 "적립기간 후 일괄 지급" 방식). 절대 원칙 3 그대로 — 결제/계좌/외부 API 0줄. '
  '[학생이 금액도 시점도 고르지 않는다] 인자가 0개다. 이것이 convert_points_to_currency 를 없앤 이유다. '
  '[멱등] 같은 달 두 번째 정산은 unique (student_id, settled_month) 가 23505 로 막는다. 화면에 들어올 때마다 '
  '호출해도 안전하다. [cron 이 아닌 이유] 정산 결과는 시각이 아니라 날짜의 함수라 언제 계산해도 답이 같다. '
  '[월 경계는 KST] created_at 을 Asia/Seoul 로 변환해 자른다 — UTC 로 자르면 9월 1일 새벽 적립이 8월분이 된다. '
  '[반환] settled(이번에 정산된 달) + pending(전환 예정) + 잔액 3종을 한 번에 준다.';

revoke all on function public.settle_my_points() from public;
grant execute on function public.settle_my_points() to authenticated;

-- =========================================================
-- 3. convert_points_to_currency() 제거 — 학생 주도 전환 경로를 없앤다
--
-- [revoke 가 아니라 drop 인 이유]
--   목표는 "학생이 원할 때 원하는 금액을 전환하지 못하게" 다. grant 만 회수하면 함수는 남아 있고,
--   나중에 누군가 grant 한 줄로 되살릴 수 있다 — 그러면 정산 규칙 옆에 우회로가 상시 존재하게 된다.
--   이 저장소의 규율은 "잘못된 것을 어렵게 만드는 게 아니라 불가능하게 만든다" 이므로 함수 자체를 없앤다.
--   >>> 이 자리에 create or replace 로 전환 함수를 다시 만들지 말 것. 전환은 settle_my_points() 하나다.
--
-- [원장은 지우지 않는다] 이미 생긴 '전환' 행과 그것이 옮긴 currency_balance 는 일어난 사실이다.
--   그 행들은 settled_month 가 NULL 이라 새 unique 제약에도 걸리지 않는다.
-- =========================================================
drop function if exists public.convert_points_to_currency(integer);
