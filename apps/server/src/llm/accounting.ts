export const heldReservationSql =
  "COALESCE(SUM(CASE WHEN cost_usd IS NULL AND state IN ('Reserved','Sent','Ambiguous','Answered') THEN reserved_usd ELSE 0 END),0)";
