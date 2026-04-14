export type SearchHit = {
  id: number;
  rank: number;
  result_mode?: "materialized" | "lazy";
  composite_art: string;
  composite_art_normalized: string;
  base_art: string;
  add_art: string;
  display_name: string;
  base_name: string;
  add_name: string;
  source_filename: string;
  source_sheet: string;
  source_row_base: number;
  source_row_add: number;
  import_job_id: string;
  created_at: string;
};
