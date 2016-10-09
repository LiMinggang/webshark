#ifndef __SHARKD_H
#define __SHARKD_H

/* sharkd.c */
cf_status_t sharkd_cf_open(const char *fname, unsigned int type, gboolean is_tempfile, int *err);
int sharkd_load_cap_file(void);
int sharkd_retap(void);
int sharkd_filter(const char *dftext, guint8 **result);
int sharkd_dissect_columns(int framenum, column_info *cinfo, gboolean dissect_color);
int sharkd_dissect_request(int framenum, void (*cb)(packet_info *, proto_tree *, struct epan_column_info *, const GSList *, void *), int dissect_bytes, int dissect_columns, int dissect_tree, void *data);
const char *sharkd_version(void);

extern capture_file cfile;

/* sharkd_daemon.c */
int sharkd_init(int argc, char **argv);
int sharkd_loop(void);

#endif /* __SHARKD_H */
