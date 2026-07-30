// Accumu v2 — 활동 상세 모달 (아카이브 활동 행 클릭 — 확정 A: 새 라우트 없이 모달)
//
// [왜 모달인가] 하단 탭바 4개(홈·프로그램·아카이브·마이)가 이미 정보구조다. 아카이브 하위에 목록/상세
//   2단계를 또 만들면 모바일에서 뒤로가기 의미가 흐려진다. 관리자 아카이브가 2단계인 이유는
//   "학생 5명을 한 화면에 놓지 않기 위해서"인데, 본인 화면에는 학생이 1명뿐이라 그 이유가 없다.
//   인쇄 대상은 모달이 아니라 페이지 본문이라 PDF 에도 영향이 없다.
//
// [방어적 렌더] 게시중단된 프로그램은 학생이 select 할 수 없다. 이 모달은 그 경우에도 열리고,
//   "참여 기록 자체는 유지된다"는 사실을 문구로 알린다 (ADR 0005 결정 7-4).
import Modal from '../Modal';
import Icon from '../Icon';
import { describeActivity } from '../../lib/archiveService';
import { fmtDateTime } from '../../lib/date';
import { TRACK } from '../../lib/taxonomy';

export default function ActivityDetailModal({ activity, onClose }) {
  const d = describeActivity(activity);
  const track = d.careerTrack ? TRACK[d.careerTrack]?.name : null;

  return (
    <Modal onClose={onClose} labelledBy="act-title" className="act-modal">
      <div className="mbody">
        <span className="mtag" style={{ background: d.cat.soft, color: d.cat.color }}>
          {d.catLabel}
        </span>
        <h3 id="act-title">{d.title}</h3>

        {!d.known && (
          <p className="act-degraded">
            이 프로그램은 현재 게시가 중단되어 상세 정보를 불러올 수 없어요. 참여 기록과 포인트는 그대로
            유지됩니다.
          </p>
        )}

        <div className="infogrid">
          {d.org && (
            <div className="it">
              <div className="k">
                <Icon name="ic-building" size={13} />
                주최
              </div>
              <div className="v">{d.org}</div>
            </div>
          )}
          {d.dateLabel && (
            <div className="it">
              <div className="k">
                <Icon name="ic-calendar" size={13} />
                활동일
              </div>
              <div className="v">{d.dateLabel}</div>
            </div>
          )}
          {d.time && (
            <div className="it">
              <div className="k">
                <Icon name="ic-clock" size={13} />
                시간
              </div>
              <div className="v">{d.time}</div>
            </div>
          )}
          {track && (
            <div className="it">
              <div className="k">
                <Icon name="ic-target" size={13} />
                진로 계열
              </div>
              <div className="v">{track}</div>
            </div>
          )}
          {/* 참여 확인 일시 = QR 퇴장 인증 시각. 아카이브의 모든 활동이 2회 인증을 통과했다는 근거다. */}
          <div className="it wide">
            <div className="k">
              <Icon name="ic-qr" size={13} />
              참여 확인 일시
            </div>
            <div className="v">{fmtDateTime(activity?.exit_at) || '기록 없음'}</div>
          </div>
        </div>

        {/* [자리 — 나의 만족도 · 한 줄 평]
            reviews 테이블(+ select/insert/update 정책)이 생기면 여기에 ReviewForm 이 들어간다.
            docs/specs/student-archive-mypage.md 결정 D-4: 작성·수정 가능, 삭제 없음, 참여 1건 = 리뷰 1행.
            리뷰의 경계는 participations 이지 programs 가 아니므로 게시중단 건에도 평가를 남길 수 있다. */}
      </div>
    </Modal>
  );
}
