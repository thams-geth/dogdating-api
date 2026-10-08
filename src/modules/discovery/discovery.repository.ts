import type { PoolClient } from 'pg';
// Both feed and impression-scoped profile reads use this same live eligibility predicate.
const candidateSql=`FROM graph.discovery_dogs a
 JOIN graph.match_preferences ap ON ap.dog_id=a.id
 JOIN graph.discovery_dogs t ON t.metro_id=a.metro_id AND t.household_id<>a.household_id
 JOIN graph.match_preferences tp ON tp.dog_id=t.id
 WHERE a.id=$1
 AND NOT EXISTS(SELECT 1 FROM identity.household_members own WHERE own.user_id=$2 AND own.household_id=t.household_id AND own.accepted_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM identity.household_members x JOIN safety.blocks b ON b.blocker_user_id=x.user_id OR b.blocked_user_id=x.user_id
   JOIN identity.household_members y ON y.user_id=CASE WHEN b.blocker_user_id=x.user_id THEN b.blocked_user_id ELSE b.blocker_user_id END
   WHERE x.household_id=a.household_id AND y.household_id=t.household_id AND x.accepted_at IS NOT NULL AND y.accepted_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM meetup.decisions d WHERE d.actor_dog_id=a.id AND d.target_dog_id=t.id AND d.mode='pack'
   AND (d.verdict='interest' OR d.decided_at>now()-interval '180 days'))
 AND NOT EXISTS(SELECT 1 FROM meetup.matches m WHERE m.mode='pack' AND ((m.dog_a_id=a.id AND m.dog_b_id=t.id) OR (m.dog_b_id=a.id AND m.dog_a_id=t.id)))
 AND (cardinality(ap.size_classes)=0 OR t.size_class=ANY(ap.size_classes))
 AND (cardinality(tp.size_classes)=0 OR a.size_class=ANY(tp.size_classes))
 AND (cardinality(a.size_tolerance)=0 OR t.size_class=ANY(a.size_tolerance))
 AND (cardinality(t.size_tolerance)=0 OR a.size_class=ANY(t.size_tolerance))
 AND (ap.age_min_months IS NULL OR t.age_months>=ap.age_min_months) AND (ap.age_max_months IS NULL OR t.age_months<=ap.age_max_months)
 AND (tp.age_min_months IS NULL OR a.age_months>=tp.age_min_months) AND (tp.age_max_months IS NULL OR a.age_months<=tp.age_max_months)
 AND (ap.energy_min IS NULL OR t.energy>=ap.energy_min) AND (ap.energy_max IS NULL OR t.energy<=ap.energy_max)
 AND (tp.energy_min IS NULL OR a.energy>=tp.energy_min) AND (tp.energy_max IS NULL OR a.energy<=tp.energy_max)
 AND (ap.play_styles IS NULL OR cardinality(ap.play_styles)=0 OR ap.play_styles&&t.play_style)
 AND (tp.play_styles IS NULL OR cardinality(tp.play_styles)=0 OR tp.play_styles&&a.play_style)
 AND t.effective_tier>=greatest(1,ap.min_verification_tier) AND a.effective_tier>=greatest(1,tp.min_verification_tier)
 AND (t.dog_reactivity<4 OR (ap.accepts_reactive AND ap.parallel_walk_only))
 AND (a.dog_reactivity<4 OR (tp.accepts_reactive AND tp.parallel_walk_only))`;
export class DiscoveryRepository {
  async ranked(tx:PoolClient,dogId:string,userId:string){
    return (await tx.query(`SELECT t.id,
      (5-abs(a.energy-t.energy))*10 + CASE WHEN a.size_class=t.size_class THEN 10 ELSE 0 END
      + CASE WHEN a.play_style&&t.play_style THEN 20 ELSE 0 END
      + CASE WHEN EXISTS(SELECT 1 FROM graph.dog_availability av JOIN graph.dog_availability tv
          ON av.day_of_week=tv.day_of_week AND av.start_min<tv.end_min AND tv.start_min<av.end_min
          JOIN graph.dogs ad ON ad.id=av.dog_id JOIN graph.dogs td ON td.id=tv.dog_id
          WHERE av.dog_id=a.id AND tv.dog_id=t.id AND ad.availability_timezone=td.availability_timezone) THEN 10 ELSE 0 END AS score
      ${candidateSql} ORDER BY score DESC,t.id LIMIT 200`,[dogId,userId])).rows as {id:string;score:number}[];
  }
  async cards(tx:PoolClient,dogId:string,userId:string,ids:string[],offset:number,limit:number){
    return (await tx.query(`SELECT t.id,t.name,t.sex,t.size_class AS "sizeClass",t.age_months AS "ageMonths",t.bio,
      t.energy,t.play_style AS "playStyle",t.dog_reactivity AS "dogReactivity",t.human_reactivity AS "humanReactivity",
      t.effective_tier AS "verificationTier",t.published_by AS "guardianId",t.guardian_name AS "guardianName",
      array_position($3::uuid[],t.id)-1 AS position,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'width',p.width,'height',p.height) ORDER BY p.ordinal)
        FROM graph.dog_media p LEFT JOIN graph.media_uploads u ON u.media_id=p.id WHERE p.dog_id=t.id AND p.deleted_at IS NULL
        AND p.moderation_state='approved' AND p.kind='photo' AND (u.media_id IS NULL OR u.state='completed')),'[]'::jsonb) AS photos
      ${candidateSql} AND t.id=ANY($3::uuid[]) AND array_position($3::uuid[],t.id)>$4
      ORDER BY array_position($3::uuid[],t.id) LIMIT $5`,[dogId,userId,ids,offset,limit])).rows;
  }
}
