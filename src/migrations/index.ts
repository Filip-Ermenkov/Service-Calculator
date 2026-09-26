import * as migration_20260707_153821_initial from './20260707_153821_initial';
import * as migration_20260717_164130_phase2b_slug_service_snapshot from './20260717_164130_phase2b_slug_service_snapshot';
import * as migration_20260825_173608_service_editor_unit_default_on from './20260825_173608_service_editor_unit_default_on';
import * as migration_20260914_165124_projects_media_orderable from './20260914_165124_projects_media_orderable';
import * as migration_20260918_180113_media_prefix from './20260918_180113_media_prefix';
import * as migration_20260926_093726_payload_390_reset_interval_object_key from './20260926_093726_payload_390_reset_interval_object_key';

export const migrations = [
  {
    up: migration_20260707_153821_initial.up,
    down: migration_20260707_153821_initial.down,
    name: '20260707_153821_initial',
  },
  {
    up: migration_20260717_164130_phase2b_slug_service_snapshot.up,
    down: migration_20260717_164130_phase2b_slug_service_snapshot.down,
    name: '20260717_164130_phase2b_slug_service_snapshot',
  },
  {
    up: migration_20260825_173608_service_editor_unit_default_on.up,
    down: migration_20260825_173608_service_editor_unit_default_on.down,
    name: '20260825_173608_service_editor_unit_default_on',
  },
  {
    up: migration_20260914_165124_projects_media_orderable.up,
    down: migration_20260914_165124_projects_media_orderable.down,
    name: '20260914_165124_projects_media_orderable',
  },
  {
    up: migration_20260918_180113_media_prefix.up,
    down: migration_20260918_180113_media_prefix.down,
    name: '20260918_180113_media_prefix',
  },
  {
    up: migration_20260926_093726_payload_390_reset_interval_object_key.up,
    down: migration_20260926_093726_payload_390_reset_interval_object_key.down,
    name: '20260926_093726_payload_390_reset_interval_object_key'
  },
];
