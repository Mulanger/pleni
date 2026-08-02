# KBLab Reference Fixture

This directory holds a compact C3 sample from KBLab `riksdagen_anforanden`
metadata covering three 2022 reference debates. C3 uses it to validate
speech-boundary refinement against published corrected timestamps.

`metadata_sample.json` is sampled from KBLab's published
`metadata/adjusted_metadata.csv.gz`. It keeps only `dokid`, speech number,
speaker, party, raw Riksdagen start/end, and KBLab adjusted start/end.
