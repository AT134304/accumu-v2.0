-- Accumu v2 — 대기열 승격 알림 (ADR 0018)
--
-- [배경] 케빈이 지목한 사용성 문제 6번: "대기 승격 알림이 없음". cancel_my_participation()이
--   waitlisted 학생을 applied로 승격시켜도(ADR 0016) 그 학생에게는 아무 알림이 안 갔다 — 다음에
--   프로그램 선택 화면을 직접 열어야만 "어, 신청됐네"를 알 수 있었다.
--
-- [왜 트리거가 자동으로 못 잡는가] notifications_on_participation() 트리거(20260806120000)는 UPDATE에서
--   entry_at/exit_at 변화만 본다 — status만 바뀌는 승격은 그 트리거의 어느 조건에도 안 걸린다.
--   status 변화 전체를 그 트리거에 얹으면 다른 status 전이(예: capacity_guard의 최초 waitlisted 배정)
--   까지 알림을 쏘게 될 위험이 있어, 승격이라는 이 함수 안의 구체적 사건 하나만 명시적으로 알린다
--   (RPC 안에서 발생하는 부수효과이므로 그 RPC가 직접 아는 것이 가장 정확하다).
--
-- [선행 조건] **20260808100000(재실행) → 이 파일** 순서. notification_type에 'promoted' 값이 먼저
--   커밋돼 있어야 한다(55P04) — 20260808100000 파일 하단에 그 값을 추가해 뒀다.
--
-- [바뀐 부분] cancel_my_participation() 본문 중 승격 성공 판정(v_promoted := (v_rows = 1)) 바로 뒤에
--   notify_user() 호출 한 단락이 늘었을 뿐, 그 앞뒤 로직(취소 조건·날짜 검사·delete·승격 대상 선택)은
--   20260810180000판과 완전히 동일하다.

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

      -- [ADR 0018 — 새로 추가된 단락] 승격된 학생에게 알린다. v_next는 그 학생의 participation id지
      -- profile id가 아니므로, 알림 수신자는 participations.student_id를 다시 읽어야 한다 — 방금 막
      -- update한 행이니 v_next 자체가 아니라 그 행이 가리키는 학생이 대상이다.
      if v_promoted then
        perform public.notify_user(
          (select student_id from public.participations where id = v_next),
          'promoted', '대기하던 자리가 확정됐어요',
          v_prog.title || coalesce(' · ' || v_prog.time, ''), v_prog.id
        );
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'promoted', coalesce(v_promoted, false));
end;
$$;

comment on function public.cancel_my_participation(uuid) is
  '[ADR 0016 + ADR 0018] 학생 본인의 참여 신청 취소. 프로그램 시작일 전날까지만 가능(오늘 >= date면
   too_late). applied/waitlisted만 취소 대상이고 entered/completed는 already_started로 거부한다.
   취소한 행이 applied(자리 보유)였고 정원이 있으면, 그 프로그램의 waitlisted 중 가장 먼저 신청한 1명을
   applied로 승격하고(선착순, for update로 중복 승격 방지) 그 학생에게 notify_user()로 알림을 보낸다
   (type=promoted). participations에 update/delete 정책이 여전히 0개라 이 함수가 유일한 취소·승격·
   승격 알림 경로다.';

revoke all on function public.cancel_my_participation(uuid) from public;
grant execute on function public.cancel_my_participation(uuid) to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 정원 1짜리 프로그램: A(applied) 신청 -> B(waitlisted) 신청 -> A 취소
--   2) B로 로그인해 알림 팝업 확인 -> "대기하던 자리가 확정됐어요" · 프로그램명이 떠 있는지
--   3) B의 participations.status가 실제로 applied로 바뀌었는지(알림과 실제 상태가 같은 사건인지)
-- =========================================================
