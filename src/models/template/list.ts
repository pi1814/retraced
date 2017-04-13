import * as _ from "lodash";

import getPgPool from "../../persistence/pg";

const pgPool = getPgPool();

export interface Options {
  environmentId: string;
}

export interface Result {
  templates: any[];
}

export default async function(opts: Options): Promise<Result> {
  // This will return the display templates IN ORDER FOR APPLICATION
  // (said order is current undefined)
  // This is used internally today when attempting to render
  // a large set of events.

  const pg = await pgPool.connect();
  try {
    const fields = `name, rule, template`;
    const q = `select ${fields} from display_template where environment_id = $1`;
    const v = [
      opts.environmentId,
    ];
    const pgResult = await pg.query(q, v);

    const result: Result = {
      templates: pgResult.rows,
    };

    return result;

  } finally {
    pg.release();
  }
}
