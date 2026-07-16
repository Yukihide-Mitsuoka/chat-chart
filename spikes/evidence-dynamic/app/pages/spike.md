---
title: Dynamic-data spike
---

<!--
  Minimal single-query page for the shell/data-separation experiment.
  One aggregate query -> one BigValue + one BarChart. Keeping the page tiny
  makes the query->parquet mapping in build/ unambiguous to dissect.
-->

```sql sales_by_category
select
    category,
    sum(sales) as sales_usd,
    count(*) as n_orders
from needful_things.orders
group by category
order by sales_usd desc
```

<BarChart data={sales_by_category} x=category y=sales_usd title="Sales by category (TENANT MARKER in data)"/>

<DataTable data={sales_by_category}/>
