import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'package:carelink/core/app_nav.dart';
import 'package:carelink/core/carelink_palette.dart';
import 'package:carelink/core/locale_controller.dart';
import 'package:carelink/core/theme_controller.dart';
import 'package:carelink/features/admin/screens/admin_booking_review_screen.dart';
import 'package:carelink/features/admin/widgets/admin_ui_support.dart';
import 'package:carelink/features/notifications/notifications_screen.dart';
import 'package:carelink/shared/models/user.dart';
import 'package:carelink/shared/services/api_service.dart';
import 'package:carelink/shared/widgets/carelink_background.dart';
import 'package:carelink/shared/widgets/carelink_theme_toggle.dart';

class AdminHomeScreen extends StatefulWidget {
  const AdminHomeScreen({super.key, required this.user});

  final User user;

  @override
  State<AdminHomeScreen> createState() => _AdminHomeScreenState();
}

class _AdminHomeScreenState extends State<AdminHomeScreen> {
  static const _teal = Color(0xFF039D98);
  static const _darkTeal = Color(0xFF007B78);
  static const _ink = Color(0xFF0D1B2A);
  static const _muted = Color(0xFF6B7C86);
  static const _line = Color(0xFFD7E7E5);

  CarelinkPalette get _palette => CarelinkPalette.of(context);
  Color get _surface => _palette.surface;
  Color get _onPrimary => Theme.of(context).colorScheme.onPrimary;

  bool _loading = true;
  String? _error;
  int _tabIndex = 0;
  String _requestFilter = 'all';
  String _requestQuery = '';
  String _providerFilter = 'all';
  String? _providerQuery;
  String _userFilter = 'all';
  String _userQuery = '';
  String _ratingFilter = 'all';
  bool _showAllRatings = false;
  int _financeTab = 0;
  String _transactionFilter = 'all';
  String _payoutFilter = 'all';
  String _statisticsRange = 'This Month';
  Map<String, dynamic> _data = const {};

  Map<String, dynamic> get _metrics =>
      Map<String, dynamic>.from(_data['metrics'] ?? const {});
  List<Map<String, dynamic>> get _requests => _list(_data['requests']);
  List<Map<String, dynamic>> get _users => _list(_data['users']);
  List<Map<String, dynamic>> get _ratings => _list(_data['ratings']);
  List<Map<String, dynamic>> get _bookingReviewItems =>
      _list(_data['bookingReview']);
  Map<String, dynamic> get _performance =>
      Map<String, dynamic>.from(_data['performance'] ?? const {});
  List<Map<String, dynamic>> get _serviceRequests =>
      _list(_performance['recentRequests']);
  Map<String, dynamic> get _finance =>
      Map<String, dynamic>.from(_data['finance'] ?? const {});
  Map<String, dynamic> get _financeOverview =>
      Map<String, dynamic>.from(_finance['overview'] ?? const {});
  List<Map<String, dynamic>> get _pricing => _list(_finance['pricing']);
  List<Map<String, dynamic>> get _transactions =>
      _list(_finance['transactions']);
  List<Map<String, dynamic>> get _payouts => _list(_finance['payouts']);
  List<Map<String, dynamic>> get _wallets => _list(_finance['wallets']);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await http.get(_uri('/admin/dashboard'));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      final decoded = jsonDecode(response.body);
      if (!mounted) return;
      setState(() => _data = Map<String, dynamic>.from(decoded as Map));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: adminUiSettings,
      builder: (context, _) => _buildAdminScreen(context),
    );
  }

  Widget _buildAdminScreen(BuildContext context) {
    final p = _palette;
    return Theme(
      data: adminCareTheme(context),
      child: Directionality(
        textDirection: context.adminTextDirection,
        child: PatientScaffold(
          extendBody: true,
          enabled: false,
          backgroundColor: p.surface,
          body: SafeArea(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1100),
                child: Column(
                  children: [
                    Expanded(
                      child: _loading
                          ? const AdminLoadingState()
                          : _error != null
                          ? _ErrorState(message: _error!, onRetry: _load)
                          : RefreshIndicator(
                              color: _teal,
                              onRefresh: _load,
                              child: AnimatedSwitcher(
                                duration: Duration(milliseconds: 240),
                                switchInCurve: Curves.easeOutCubic,
                                switchOutCurve: Curves.easeInCubic,
                                child: KeyedSubtree(
                                  key: ValueKey(_tabIndex),
                                  child: _currentPage(),
                                ),
                              ),
                            ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          bottomNavigationBar: _tabIndex == 7 ? null : _bottomNav(),
        ),
      ),
    );
  }

  Widget _currentPage() {
    switch (_tabIndex) {
      case 1:
        return _requestsPage();
      case 2:
        return _providersPage();
      case 3:
        return _usersPage();
      case 4:
        return _ratingsPage();
      case 5:
        return _financePage();
      case 6:
        return _statisticsPage();
      case 7:
        return _adminSettingsPage();
      default:
        return _dashboardPage();
    }
  }

  Widget _dashboardPage() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final horizontal = constraints.maxWidth < 360 ? 10.0 : 14.0;
        return ListView(
          padding: EdgeInsets.fromLTRB(horizontal, 8, horizontal, 24),
          children: [
            _adminTopBar(),
            const SizedBox(height: 10),
            _dashboardHeroCard(),
            const SizedBox(height: 10),
            _bookingReviewShortcut(),
            const SizedBox(height: 10),
            _dashboardRecentActivities(),
            const SizedBox(height: 10),
            _dashboardQuickActionsPanel(),
          ],
        );
      },
    );
  }

  Widget _requestsPage() {
    final query = _requestQuery.trim().toLowerCase();
    final filtered = _serviceRequests.where((request) {
      final statusGroup = _serviceStatusGroup(_text(request['status']));
      final haystack =
          '${request['patientName']} ${request['providerName']} ${request['serviceType']} ${request['location']}'
              .toLowerCase();
      return (_requestFilter == 'all' || statusGroup == _requestFilter) &&
          (query.isEmpty || haystack.contains(query));
    }).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        _requestCompactHeader(),
        const SizedBox(height: 12),
        _serviceRequestStatusTabs(),
        const SizedBox(height: 12),
        if (filtered.isEmpty)
          _empty('No service requests match this filter')
        else
          ...filtered.map(_serviceRequestTile),
      ],
    );
  }

  Widget _requestCompactHeader() {
    return SizedBox(
      height: 48,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: IconButton(
              tooltip: context.adminTr('Back'),
              onPressed: () => setState(() => _tabIndex = 0),
              icon: Icon(
                context.adminBackIcon,
                color: _palette.inkDark,
                size: 23,
              ),
            ),
          ),
          const Align(
            alignment: AlignmentDirectional.centerEnd,
            child: PatientHeaderActions(),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 92),
            child: AdminLocalizedText(
              'Service Requests',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: _palette.inkDark,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Kept for the existing reports/complaints view variants.
  // ignore: unused_element
  Widget _requestsTopBar(String title, {bool compact = false}) {
    if (compact) {
      return AdminLocalizedText(
        title,
        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
          color: _palette.inkDark,
          fontWeight: FontWeight.w800,
        ),
      );
    }
    return AdminPageHeader(
      title: title,
      onBack: () => setState(() => _tabIndex = 0),
      onRefresh: _load,
    );
  }

  Future<void> _openBookingReview() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) =>
            AdminBookingReviewScreen(serviceRequests: _serviceRequests),
      ),
    );
    if (mounted) await _load();
  }

  // ignore: unused_element
  Widget _bookingReviewInlineCard() {
    final count = _bookingReviewItems.length;
    if (count == 0) {
      return Container(
        padding: EdgeInsets.all(13),
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: _palette.stroke),
          boxShadow: _softDashboardShadow,
        ),
        child: Row(
          children: [
            Icon(Icons.verified_user_outlined, color: _teal, size: 20),
            SizedBox(width: 10),
            Expanded(
              child: AdminLocalizedText(
                'No nurse bookings need admin review right now.',
                style: TextStyle(
                  color: Color(0xFF6B7C86),
                  fontSize: 11.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: _openBookingReview,
      child: Container(
        padding: EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Color(0xFFDDEDEA)),
          boxShadow: _softDashboardShadow,
        ),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: _palette.surfaceSoft,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Icon(Icons.gavel_rounded, color: _darkTeal),
            ),
            SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AdminLocalizedText(
                    'Booking Review',
                    style: TextStyle(
                      color: _ink,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  SizedBox(height: 4),
                  AdminLocalizedText(
                    '$count nurse booking${count == 1 ? '' : 's'} need admin decision',
                    style: TextStyle(
                      color: Color(0xFF6B7C86),
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            _pill('$count', Color(0xFFE7FAF4), _teal),
            SizedBox(width: 8),
            Icon(Icons.chevron_right_rounded, color: _darkTeal),
          ],
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _requestSearchRow() {
    return Row(
      children: [
        Expanded(
          child: TextField(
            onChanged: (v) => setState(() => _requestQuery = v),
            decoration: InputDecoration(
              hintText: context.adminTr('Search requests...'),
              hintStyle: TextStyle(
                color: Color(0xFFB5C2C4),
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
              prefixIcon: Icon(
                Icons.search_rounded,
                color: Color(0xFFB5C2C4),
                size: 20,
              ),
              filled: true,
              fillColor: _surface,
              contentPadding: EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 14,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(18),
                borderSide: BorderSide.none,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(18),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        SizedBox(width: 12),
        TextButton.icon(
          onPressed: () => setState(() {
            _requestFilter = _requestFilter == 'all' ? 'pending' : 'all';
          }),
          icon: Icon(Icons.filter_list_rounded, size: 18),
          label: AdminLocalizedText('Filter'),
          style: TextButton.styleFrom(
            foregroundColor: _teal,
            textStyle: TextStyle(fontWeight: FontWeight.w900),
          ),
        ),
      ],
    );
  }

  Widget _serviceRequestStatusTabs() {
    final options = [
      ('all', 'All', _serviceRequests.length),
      (
        'pending',
        'Pending',
        _serviceRequests
            .where((r) => _serviceStatusGroup(_text(r['status'])) == 'pending')
            .length,
      ),
      (
        'completed',
        'Completed',
        _serviceRequests
            .where(
              (r) => _serviceStatusGroup(_text(r['status'])) == 'completed',
            )
            .length,
      ),
      (
        'cancelled',
        'Cancelled',
        _serviceRequests
            .where(
              (r) => _serviceStatusGroup(_text(r['status'])) == 'cancelled',
            )
            .length,
      ),
    ];
    return Row(
      children: [
        for (var index = 0; index < options.length; index++) ...[
          if (index > 0) const SizedBox(width: 7),
          Expanded(
            child: _serviceRequestChip(options[index].$1, options[index].$2),
          ),
        ],
      ],
    );
  }

  Widget _serviceRequestChip(String value, String label) {
    final selected = _requestFilter == value;
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: () => setState(() => _requestFilter = value),
      child: AnimatedContainer(
        duration: Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
        decoration: BoxDecoration(
          color: selected ? _teal : _palette.surfaceSoft,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? _teal : _palette.stroke),
        ),
        child: AdminLocalizedText(
          label,
          style: TextStyle(
            color: selected ? _onPrimary : _teal,
            fontSize: 12,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  Widget _serviceRequestTile(Map<String, dynamic> request) {
    final status = _text(request['status'], fallback: 'pending');
    final patientName = _text(request['patientName'], fallback: 'Patient');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          AdminAvatar(data: request, name: patientName, size: 54),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(request['serviceType'], fallback: 'Service request'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                AdminLocalizedText(
                  patientName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _palette.inkMuted,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(Icons.schedule_rounded, color: _teal, size: 14),
                    const SizedBox(width: 4),
                    Expanded(
                      child: AdminLocalizedText(
                        '${_shortDate(request['scheduledAt'] ?? request['createdAt'])}  ${_shortTime(request['scheduledAt'] ?? request['createdAt'])}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: _palette.inkMuted,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          _serviceStatusPill(status),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _reportsComplaintTabs() {
    return Row(
      children: [
        _reportsComplaintChip('Complaints (0)', true),
        SizedBox(width: 8),
        _reportsComplaintChip('Feedback (${_ratings.length})', false),
      ],
    );
  }

  Widget _reportsComplaintChip(String label, bool selected) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 13, vertical: 9),
      decoration: BoxDecoration(
        color: selected ? _teal : Color(0xFFE9F8F6),
        borderRadius: BorderRadius.circular(14),
      ),
      child: AdminLocalizedText(
        label,
        style: TextStyle(
          color: selected ? _onPrimary : _teal,
          fontSize: 11.5,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _reportComplaintTile(Map<String, dynamic> item) {
    final status = _int(item['stars']) <= 2
        ? 'New'
        : _int(item['stars']) >= 4
        ? 'Resolved'
        : 'In Progress';
    return Container(
      margin: EdgeInsets.only(bottom: 12),
      padding: EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          AdminAvatar(
            data: item,
            name: _text(item['patientName'], fallback: 'Patient'),
            size: 44,
          ),
          SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(item['patientName'], fallback: 'Patient'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _ink,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                SizedBox(height: 4),
                AdminLocalizedText(
                  _text(item['comment'], fallback: 'Service feedback'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: Color(0xFF64787C),
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                SizedBox(height: 8),
                AdminLocalizedText(
                  '${_shortDate(item['createdAt'])} - ${_shortTime(item['createdAt'])}',
                  style: TextStyle(
                    color: Color(0xFF9AA8AB),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _complaintStatusPill(status),
              SizedBox(height: 12),
              TextButton(
                onPressed: () => _showRatingDetails(item),
                style: TextButton.styleFrom(
                  foregroundColor: _teal,
                  textStyle: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                child: AdminLocalizedText('View'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _showRatingDetails(Map<String, dynamic> item) async {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: AdminLocalizedText(
          _text(item['patientName'], fallback: 'Feedback'),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _stars(_int(item['stars'])),
            SizedBox(height: 12),
            AdminLocalizedText(
              _text(item['comment'], fallback: 'No comment provided'),
            ),
            SizedBox(height: 12),
            AdminLocalizedText('Provider: ${_text(item['providerName'])}'),
            AdminLocalizedText('Service: ${_text(item['serviceType'])}'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: AdminLocalizedText('Close'),
          ),
        ],
      ),
    );
  }

  Widget _serviceStatusPill(String status) {
    final group = _serviceStatusGroup(status);
    final color = _serviceStatusColor(group);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(10),
      ),
      child: AdminLocalizedText(
        _serviceStatusLabel(status),
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }

  Widget _complaintStatusPill(String status) {
    final color = status == 'New'
        ? Color(0xFFE04F5F)
        : status == 'Resolved'
        ? Color(0xFF1E9D69)
        : Color(0xFFD28A00);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: AdminLocalizedText(
        status,
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }

  Widget _providersPage() {
    final q = (_providerQuery ?? '').trim().toLowerCase();
    final providers = _requests.where((provider) {
      final status = _text(provider['approvalStatus'], fallback: 'pending');
      final haystack =
          '${provider['fullName']} ${provider['email']} '
                  '${provider['specialization']} ${provider['serviceType']} ${provider['role']}'
              .toLowerCase();
      return (_providerFilter == 'all' || status == _providerFilter) &&
          (q.isEmpty || haystack.contains(q));
    }).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
      children: [
        _providersTopBar(),
        const SizedBox(height: 14),
        _directorySearchField(
          hint: 'Search provider...',
          onChanged: (value) => setState(() => _providerQuery = value),
        ),
        const SizedBox(height: 12),
        _providerStatusTabs(),
        const SizedBox(height: 14),
        if (providers.isEmpty)
          _empty('No providers match this filter')
        else
          ...providers.map(_providerRequestTile),
      ],
    );
  }

  Widget _usersPage() {
    final q = _userQuery.trim().toLowerCase();
    final filtered = _users.where((u) {
      final role = _text(u['role']);
      final haystack = '${u['fullName']} ${u['email']} ${u['phone']}'
          .toLowerCase();
      return (_userFilter == 'all' || role == _userFilter) &&
          (q.isEmpty || haystack.contains(q));
    }).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
      children: [
        _usersTopBar(),
        const SizedBox(height: 14),
        _directorySearchField(
          hint: 'Search user...',
          onChanged: (value) => setState(() => _userQuery = value),
        ),
        const SizedBox(height: 12),
        _usersRoleTabs(),
        const SizedBox(height: 14),
        if (filtered.isEmpty)
          _empty('No users match your search')
        else
          ...filtered.map(_userListRow),
      ],
    );
  }

  Widget _adminSettingsPage() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
      children: [
        SizedBox(
          height: 48,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: IconButton(
                  tooltip: context.adminTr('Back'),
                  onPressed: () => setState(() => _tabIndex = 0),
                  icon: Icon(
                    context.adminBackIcon,
                    color: _palette.inkDark,
                    size: 23,
                  ),
                ),
              ),
              AdminLocalizedText(
                'Settings',
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Row(
            children: [
              AdminAvatar(
                data: const {},
                name: widget.user.fullName.isEmpty
                    ? 'Admin'
                    : widget.user.fullName,
                size: 52,
                icon: Icons.person_rounded,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      widget.user.fullName.isEmpty
                          ? 'Admin'
                          : widget.user.fullName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkDark,
                        fontSize: 14,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    AdminLocalizedText(
                      widget.user.email,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: _palette.inkMuted, fontSize: 11),
                    ),
                    const SizedBox(height: 3),
                    const AdminLocalizedText(
                      'System Administrator',
                      style: TextStyle(
                        color: _teal,
                        fontSize: 10.5,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Container(
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Column(
            children: [
              _settingsRow(
                icon: Icons.person_rounded,
                title: 'Account Information',
                onTap: _showAdminAccountInfo,
              ),
              _settingsDivider(),
              _settingsRow(
                icon: Icons.lock_rounded,
                title: 'Change Password',
                onTap: () => _toast(
                  'Use the password reset option on the login screen.',
                ),
              ),
              _settingsDivider(),
              _settingsRow(
                icon: Icons.notifications_rounded,
                title: 'Notifications',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => NotificationsScreen(
                      userId: widget.user.userId,
                      userRole: 'admin',
                    ),
                  ),
                ),
              ),
              _settingsDivider(),
              _settingsRow(
                icon: Icons.language_rounded,
                title: 'Language',
                trailing: AdminLocalizedText(
                  localeController.isArabic ? 'Arabic' : 'English',
                  style: TextStyle(
                    color: _palette.inkMuted,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                onTap: localeController.toggle,
              ),
              _settingsDivider(),
              _settingsRow(
                icon: Icons.dark_mode_rounded,
                title: 'Dark Mode',
                trailing: Switch.adaptive(
                  value: themeController.isDark,
                  activeTrackColor: _teal,
                  onChanged: (_) => themeController.toggle(),
                ),
                onTap: themeController.toggle,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Container(
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: _settingsRow(
            icon: Icons.logout_rounded,
            title: 'Log out',
            color: adminDanger,
            showChevron: false,
            onTap: () => appNavigatorKey.currentState?.pushNamedAndRemoveUntil(
              '/login',
              (route) => false,
            ),
          ),
        ),
      ],
    );
  }

  Widget _settingsRow({
    required IconData icon,
    required String title,
    required VoidCallback onTap,
    Widget? trailing,
    Color? color,
    bool showChevron = true,
  }) {
    final foreground = color ?? _palette.inkDark;
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        child: Row(
          children: [
            Icon(icon, color: foreground, size: 19),
            const SizedBox(width: 11),
            Expanded(
              child: AdminLocalizedText(
                title,
                style: TextStyle(
                  color: foreground,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            ?trailing,
            if (showChevron) ...[
              const SizedBox(width: 6),
              Icon(
                context.adminTextDirection == TextDirection.rtl
                    ? Icons.chevron_left_rounded
                    : Icons.chevron_right_rounded,
                color: _palette.inkMuted,
                size: 19,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _settingsDivider() =>
      Divider(height: 1, indent: 14, endIndent: 14, color: _palette.stroke);

  Future<void> _showAdminAccountInfo() async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const AdminLocalizedText('Account Information'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AdminLocalizedText(widget.user.fullName),
            const SizedBox(height: 8),
            AdminLocalizedText(widget.user.email),
            const SizedBox(height: 8),
            AdminLocalizedText(widget.user.phone),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const AdminLocalizedText('Close'),
          ),
        ],
      ),
    );
  }

  Future<void> _openAdminNotifications() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) =>
            NotificationsScreen(userId: widget.user.userId, userRole: 'admin'),
      ),
    );
  }

  // Kept as an optional compact preview; Admin currently uses the exact
  // shared Patient notifications screen above.
  // ignore: unused_element
  Future<void> _openAdminNotificationsPreview() async {
    final notifications = ApiService()
        .getNotifications(widget.user.userId)
        .then(
          (items) => items
              .whereType<Map>()
              .map((item) => Map<String, dynamic>.from(item))
              .toList(),
        );
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => Dialog(
        insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        backgroundColor: _surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    IconButton(
                      tooltip: context.adminTr('Close'),
                      onPressed: () => Navigator.pop(dialogContext),
                      icon: Icon(
                        Icons.close_rounded,
                        color: _palette.inkDark,
                        size: 20,
                      ),
                    ),
                    Expanded(
                      child: AdminLocalizedText(
                        'Notifications',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: _palette.inkDark,
                          fontSize: 15,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    Icon(Icons.expand_more_rounded, color: _palette.inkMuted),
                    const SizedBox(width: 10),
                  ],
                ),
                Divider(height: 1, color: _palette.stroke),
                FutureBuilder<List<Map<String, dynamic>>>(
                  future: notifications,
                  builder: (context, snapshot) {
                    if (snapshot.connectionState == ConnectionState.waiting) {
                      return const Padding(
                        padding: EdgeInsets.all(24),
                        child: CircularProgressIndicator(color: _teal),
                      );
                    }
                    final items = snapshot.data ?? const [];
                    if (items.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.all(22),
                        child: AdminLocalizedText('No notifications yet'),
                      );
                    }
                    return Column(
                      children: [
                        for (
                          var index = 0;
                          index < items.take(3).length;
                          index++
                        ) ...[
                          _adminNotificationRow(items[index]),
                          if (index < items.take(3).length - 1)
                            Divider(height: 1, color: _palette.stroke),
                        ],
                      ],
                    );
                  },
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  height: 42,
                  child: OutlinedButton(
                    onPressed: () {
                      Navigator.pop(dialogContext);
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => NotificationsScreen(
                            userId: widget.user.userId,
                            userRole: 'admin',
                          ),
                        ),
                      );
                    },
                    child: const AdminLocalizedText('View All'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _adminNotificationRow(Map<String, dynamic> item) {
    final title = _text(
      item['title'] ?? item['subject'],
      fallback: 'Notification',
    );
    final body = _text(
      item['body'] ?? item['message'] ?? item['text'],
      fallback: '-',
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        children: [
          AdminAvatar(data: item, name: title, size: 36),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 11.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 2),
                AdminLocalizedText(
                  body,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: _palette.inkMuted, fontSize: 9.5),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          AdminLocalizedText(
            _notificationTime(item['createdAt'] ?? item['timestamp']),
            maxLines: 1,
            style: TextStyle(
              color: _palette.inkMuted,
              fontSize: 9,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  String _notificationTime(dynamic value) {
    final date = DateTime.tryParse(_text(value, fallback: ''));
    if (date == null) return '';
    final difference = DateTime.now().difference(date.toLocal());
    if (difference.inMinutes < 1) return context.adminTr('Just now');
    if (difference.inHours < 1) {
      return context.adminTr('${difference.inMinutes} minutes ago');
    }
    if (difference.inDays < 1) {
      return context.adminTr('${difference.inHours} hours ago');
    }
    return _shortDate(date.toIso8601String());
  }

  Widget _ratingsPage() {
    final filtered = _ratings.where((rating) {
      final stars = _int(rating['stars']);
      if (_ratingFilter == 'excellent') return stars >= 5;
      if (_ratingFilter == 'low') return stars <= 2;
      return true;
    }).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 28),
      children: [
        _ratingsTopBar(),
        const SizedBox(height: 10),
        _ratingsSummaryCard(),
        const SizedBox(height: 12),
        if (filtered.isEmpty)
          _empty('No ratings in the database yet')
        else
          ...(_showAllRatings ? filtered : filtered.take(3)).map(_ratingCard),
        if (filtered.length > 3) ...[
          const SizedBox(height: 2),
          OutlinedButton(
            onPressed: () => setState(() => _showAllRatings = true),
            child: AdminLocalizedText(
              _showAllRatings ? 'All Ratings' : 'View All',
            ),
          ),
        ],
      ],
    );
  }

  Widget _ratingsTopBar() {
    return AdminPageHeader(
      title: 'Ratings',
      onBack: () => setState(() => _tabIndex = 0),
      onRefresh: _load,
    );
  }

  Widget _ratingsSummaryCard() {
    final total = _ratings.length;
    final average = total == 0
        ? 0.0
        : _ratings.fold<double>(0, (sum, item) => sum + _int(item['stars'])) /
              total;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        textDirection: TextDirection.ltr,
        children: [
          SizedBox(
            width: 105,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                AdminLocalizedText(
                  average.toStringAsFixed(1),
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 28,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                _stars(average.round(), size: 14),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  '($total reviews)',
                  style: TextStyle(color: _palette.inkMuted, fontSize: 9),
                ),
              ],
            ),
          ),
          Container(width: 1, height: 90, color: _palette.stroke),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              children: [
                for (var stars = 5; stars >= 1; stars--)
                  _ratingDistributionRow(stars, total),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _ratingDistributionRow(int stars, int total) {
    final count = _ratings.where((item) => _int(item['stars']) == stars).length;
    final value = total == 0 ? 0.0 : count / total;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        textDirection: TextDirection.ltr,
        children: [
          SizedBox(
            width: 20,
            child: AdminLocalizedText(
              '$stars',
              style: TextStyle(
                color: _palette.inkDark,
                fontSize: 9.5,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const Icon(Icons.star_rounded, color: Color(0xFFF1A72E), size: 11),
          const SizedBox(width: 4),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: LinearProgressIndicator(
                value: value,
                minHeight: 6,
                color: _teal,
                backgroundColor: _palette.surfaceSoft,
              ),
            ),
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: 28,
            child: AdminLocalizedText(
              '${(value * 100).round()}%',
              textAlign: TextAlign.end,
              style: TextStyle(color: _palette.inkMuted, fontSize: 9),
            ),
          ),
        ],
      ),
    );
  }

  // Kept for the expanded ratings layout.
  // ignore: unused_element
  Widget _ratingSummaryMini(String label, int value, Color color) {
    return Expanded(
      child: Column(
        children: [
          AdminLocalizedText(
            '$value',
            style: TextStyle(
              color: color,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          SizedBox(height: 4),
          AdminLocalizedText(
            label,
            style: TextStyle(
              color: Color(0xFF718388),
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _ratingFilterTabs() {
    final options = [
      ('all', 'All (${_ratings.length})'),
      (
        'excellent',
        '5 Stars (${_ratings.where((r) => _int(r['stars']) >= 5).length})',
      ),
      ('low', 'Low (${_ratings.where((r) => _int(r['stars']) <= 2).length})'),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final option in options) ...[
            _ratingChip(option.$1, option.$2),
            SizedBox(width: 8),
          ],
        ],
      ),
    );
  }

  Widget _ratingChip(String value, String label) {
    final selected = _ratingFilter == value;
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: () => setState(() => _ratingFilter = value),
      child: AnimatedContainer(
        duration: Duration(milliseconds: 160),
        padding: EdgeInsets.symmetric(horizontal: 13, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? _teal : _surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: selected ? _teal : Color(0xFFDCEDEB)),
        ),
        child: AdminLocalizedText(
          label,
          style: TextStyle(
            color: selected ? _onPrimary : _teal,
            fontSize: 11.5,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  Widget _financePage() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 28),
      children: [
        _financeTopBar(),
        const SizedBox(height: 10),
        _financeSectionTabs(),
        const SizedBox(height: 12),
        if (_financeTab == 0) ...[
          _financeOverviewDashboard(),
          const SizedBox(height: 16),
          ..._financePricingSection(),
        ],
        if (_financeTab == 1) ..._financeTransactionsSection(),
        if (_financeTab == 2) ..._financePayoutsSection(),
        if (_financeTab == 3) ..._financeWalletsSection(),
      ],
    );
  }

  Widget _financeTopBar() {
    return SizedBox(
      height: 48,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: IconButton(
              tooltip: context.adminTr('Back'),
              onPressed: () => setState(() => _tabIndex = 0),
              icon: Icon(
                context.adminBackIcon,
                color: _palette.inkDark,
                size: 23,
              ),
            ),
          ),
          const Align(
            alignment: AlignmentDirectional.centerEnd,
            child: PatientHeaderActions(),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 92),
            child: AdminLocalizedText(
              'Finance',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: _palette.inkDark,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Kept for the detailed finance sub-page variants.
  // ignore: unused_element
  String _financeTitle() {
    switch (_financeTab) {
      case 1:
        return 'Transactions';
      case 2:
        return 'Payment Requests';
      case 3:
        return 'Nurse Earnings Details';
      default:
        return 'Service Pricing Manager';
    }
  }

  // ignore: unused_element
  Widget _financeSummaryStrip() {
    return Container(
      padding: EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          _financeStripItem(
            'Revenue',
            _money(_financeOverview['totalRevenue']),
          ),
          _financeStripItem(
            'Profit',
            _money(_financeOverview['platformProfit']),
          ),
          _financeStripItem(
            'Pending',
            _money(_financeOverview['pendingEscrow']),
          ),
        ],
      ),
    );
  }

  Widget _financeStripItem(String label, String value) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AdminLocalizedText(
            label,
            style: TextStyle(
              color: Color(0xFF738488),
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
            ),
          ),
          SizedBox(height: 5),
          AdminLocalizedText(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _ink,
              fontSize: 13,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }

  Widget _financeSectionTabs() {
    final tabs = [
      ('Overview', Icons.dashboard_outlined),
      ('Transactions', Icons.receipt_long_outlined),
      ('Payouts', Icons.payments_outlined),
      ('Earnings', Icons.account_balance_wallet_outlined),
    ];
    return Row(
      children: [
        for (var i = 0; i < tabs.length; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          Expanded(child: _financeTabChip(i, tabs[i].$1, tabs[i].$2)),
        ],
      ],
    );
  }

  Widget _financeTabChip(int index, String label, IconData icon) {
    final selected = _financeTab == index;
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => setState(() => _financeTab = index),
      child: AnimatedContainer(
        duration: Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? _teal : _surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? _teal : Color(0xFFDCEDEB)),
        ),
        child: AdminLocalizedText(
          label,
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: selected ? _onPrimary : _palette.inkDark,
            fontSize: 10.5,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  Widget _financeOverviewDashboard() {
    final revenue = _num(_financeOverview['totalRevenue']);
    final profit = _num(_financeOverview['platformProfit']);
    final pending = _payouts.where((item) {
      final status = _text(item['status']).toLowerCase();
      return status == 'requested' || status == 'pending';
    }).length;
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      'Total Revenue',
                      style: TextStyle(
                        color: _palette.inkMuted,
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 4),
                    AdminLocalizedText(
                      _money(revenue),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkDark,
                        fontSize: 22,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(
                          Icons.calendar_today_outlined,
                          color: adminSuccess,
                          size: 13,
                        ),
                        const SizedBox(width: 2),
                        AdminLocalizedText(
                          'This Month',
                          style: const TextStyle(
                            color: adminSuccess,
                            fontSize: 10.5,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              Container(
                width: 54,
                height: 54,
                decoration: BoxDecoration(
                  color: _palette.surfaceSoft,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: const Icon(
                  Icons.account_balance_wallet_outlined,
                  color: _darkTeal,
                  size: 27,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _financeOverviewMini(
                'Platform Profit',
                _money(profit),
                'Net earnings',
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _financeOverviewMini(
                'Withdrawal Requests',
                '$pending',
                'Pending review',
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                'Revenue',
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 12),
              AspectRatio(
                aspectRatio: 2.15,
                child: CustomPaint(
                  painter: _LineChartPainter(
                    _trendPoints(revenue <= 0 ? 1 : revenue),
                    _darkTeal,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _financeOverviewMini(String label, String value, String subtitle) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AdminLocalizedText(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _palette.inkMuted,
              fontSize: 9.5,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          AdminLocalizedText(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _palette.inkDark,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 4),
          AdminLocalizedText(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: adminSuccess,
              fontSize: 9,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _financePricingSection() {
    return [
      Row(
        children: [
          Expanded(
            child: AdminLocalizedText(
              'Set prices for each service. These will be shown to patients.',
              style: TextStyle(
                color: Color(0xFF718388),
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          SizedBox(width: 12),
          FilledButton.icon(
            style: FilledButton.styleFrom(
              backgroundColor: _teal,
              foregroundColor: _onPrimary,
              visualDensity: VisualDensity.compact,
            ),
            onPressed: () => _editPricing(),
            icon: Icon(Icons.add_rounded, size: 17),
            label: AdminLocalizedText(
              'Add',
              style: TextStyle(fontWeight: FontWeight.w900),
            ),
          ),
        ],
      ),
      SizedBox(height: 12),
      if (_pricing.isEmpty)
        _empty('No pricing rules yet')
      else
        ..._pricing.map(_servicePricingTile),
    ];
  }

  List<Widget> _financeTransactionsSection() {
    final paidTransactions = _transactions
        .where((t) => _text(t['paymentStatus']).toLowerCase() == 'paid')
        .toList();
    final refundTransactions = _transactions.where((t) {
      final paymentStatus = _text(t['paymentStatus']).toLowerCase();
      final escrowStatus = _text(t['escrowStatus']).toLowerCase();
      return paymentStatus.contains('refund') ||
          escrowStatus.contains('refund');
    }).toList();
    final visibleTransactions = _transactionFilter == 'paid'
        ? paidTransactions
        : _transactionFilter == 'refunds'
        ? refundTransactions
        : _transactions;

    return [
      _financeMiniFilterBar(
        [
          ('all', 'All (${_transactions.length})'),
          ('paid', 'Paid (${paidTransactions.length})'),
          ('refunds', 'Refunds (${refundTransactions.length})'),
        ],
        selected: _transactionFilter,
        onSelected: (value) => setState(() => _transactionFilter = value),
      ),
      SizedBox(height: 12),
      if (visibleTransactions.isEmpty)
        _empty(
          _transactionFilter == 'paid'
              ? 'No paid transactions yet'
              : _transactionFilter == 'refunds'
              ? 'No refunds yet'
              : 'No financial transactions yet',
        )
      else
        ...visibleTransactions.take(30).map(_financeTransactionTile),
    ];
  }

  List<Widget> _financePayoutsSection() {
    final pending = _payouts
        .where((p) => _text(p['status']).toLowerCase() == 'requested')
        .toList();
    final approved = _payouts
        .where((p) => _text(p['status']).toLowerCase() == 'paid')
        .toList();
    final rejected = _payouts
        .where((p) => _text(p['status']).toLowerCase() == 'rejected')
        .toList();
    final visiblePayouts = _payoutFilter == 'pending'
        ? pending
        : _payoutFilter == 'approved'
        ? approved
        : _payoutFilter == 'rejected'
        ? rejected
        : _payouts;

    return [
      _financeMiniFilterBar(
        [
          ('all', 'All (${_payouts.length})'),
          ('pending', 'Pending (${pending.length})'),
          ('approved', 'Approved (${approved.length})'),
          ('rejected', 'Rejected (${rejected.length})'),
        ],
        selected: _payoutFilter,
        onSelected: (value) => setState(() => _payoutFilter = value),
      ),
      SizedBox(height: 12),
      if (visiblePayouts.isEmpty)
        _empty('No payout requests match this filter')
      else
        ...visiblePayouts.take(30).map(_paymentRequestTile),
    ];
  }

  List<Widget> _financeWalletsSection() {
    return [
      if (_wallets.isEmpty)
        _empty('No provider wallets yet')
      else
        ..._wallets.take(30).map(_earningsDetailsTile),
    ];
  }

  Widget _financeMiniFilterBar(
    List<(String, String)> options, {
    required String selected,
    required ValueChanged<String> onSelected,
  }) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final option in options) ...[
            InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () => onSelected(option.$1),
              child: AnimatedContainer(
                duration: Duration(milliseconds: 160),
                padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: selected == option.$1 ? _teal : Color(0xFFE9F8F6),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: AdminLocalizedText(
                  option.$2,
                  style: TextStyle(
                    color: selected == option.$1 ? _onPrimary : _teal,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ),
            SizedBox(width: 8),
          ],
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _pricingPage() {
    return _page(
      title: 'Pricing',
      subtitle: 'Set provider rates and admin commissions',
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: _teal),
            onPressed: () => _editPricing(),
            icon: Icon(Icons.add_rounded),
            label: AdminLocalizedText('Add Pricing'),
          ),
        ),
        SizedBox(height: 12),
        if (_pricing.isEmpty)
          _empty('No pricing rules yet')
        else
          ..._pricing.map(_pricingCard),
      ],
    );
  }

  Widget _page({
    required String title,
    required String subtitle,
    required List<Widget> children,
  }) {
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        _heroHeader(title, subtitle),
        Padding(
          padding: EdgeInsets.fromLTRB(18, 16, 18, 24),
          child: Column(children: children),
        ),
      ],
    );
  }

  Widget _heroHeader(String title, String subtitle) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16),
      decoration: BoxDecoration(
        color: _darkTeal,
        borderRadius: BorderRadius.only(
          bottomLeft: Radius.circular(2),
          bottomRight: Radius.circular(2),
        ),
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: context.adminTr('Log out'),
            onPressed: () {
              appNavigatorKey.currentState?.pushNamedAndRemoveUntil(
                '/login',
                (route) => false,
              );
            },
            icon: Icon(Icons.logout_rounded, color: _onPrimary),
          ),
          Spacer(),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              AdminLocalizedText(
                'CareLink - Admin Dashboard',
                style: TextStyle(
                  color: _onPrimary.withValues(alpha: .72),
                  fontSize: 12,
                ),
              ),
              AdminLocalizedText(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _onPrimary,
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                ),
              ),
              AdminLocalizedText(
                subtitle,
                style: TextStyle(color: _onPrimary, fontSize: 13),
              ),
            ],
          ),
          SizedBox(width: 18),
          CircleAvatar(
            backgroundColor: _onPrimary.withValues(alpha: 0.16),
            child: IconButton(
              tooltip: context.adminTr('Refresh'),
              onPressed: _load,
              icon: Icon(Icons.notifications_none_rounded, color: _onPrimary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _adminTopBar() {
    Map<String, dynamic> adminData = {
      'fullName': widget.user.fullName,
      'userId': widget.user.userId,
    };
    for (final user in _users) {
      final sameId =
          widget.user.userId.isNotEmpty &&
          _text(user['userId'], fallback: '') == widget.user.userId;
      final sameEmail =
          widget.user.email.isNotEmpty &&
          _text(user['email'], fallback: '') == widget.user.email;
      if (sameId || sameEmail) {
        adminData = user;
        break;
      }
    }
    final notificationCount =
        _bookingReviewItems.length + _int(_metrics['pendingProviders']);
    final firstName = widget.user.fullName.trim().isEmpty
        ? 'Admin'
        : widget.user.fullName.trim().split(RegExp(r'\s+')).first;
    return Row(
      children: [
        IconButton(
          tooltip: context.adminTr('Menu'),
          onPressed: () => setState(() => _tabIndex = 7),
          icon: Icon(Icons.menu_rounded, color: _palette.inkDark, size: 25),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                'Admin Dashboard',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 2),
              AdminLocalizedText(
                'Welcome, $firstName',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _palette.inkMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        Stack(
          clipBehavior: Clip.none,
          children: [
            IconButton(
              tooltip: context.adminTr('Notifications'),
              onPressed: _openAdminNotifications,
              icon: const Icon(
                Icons.notifications_none_rounded,
                color: _darkTeal,
                size: 22,
              ),
            ),
            if (notificationCount > 0)
              PositionedDirectional(
                top: 2,
                end: 1,
                child: Container(
                  constraints: const BoxConstraints(
                    minWidth: 17,
                    minHeight: 17,
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  decoration: const BoxDecoration(
                    color: adminDanger,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    notificationCount > 9 ? '9+' : '$notificationCount',
                    style: TextStyle(
                      color: _onPrimary,
                      fontSize: 8,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
              ),
          ],
        ),
        const PatientHeaderActions(),
        const SizedBox(width: 4),
        AdminAvatar(
          data: adminData,
          name: widget.user.fullName.isEmpty ? 'Admin' : widget.user.fullName,
          size: 38,
          icon: Icons.admin_panel_settings_rounded,
        ),
      ],
    );
  }

  Widget _dashboardHeroCard() {
    final revenue = _num(_financeOverview['totalRevenue']);
    final values = [
      (
        Icons.groups_2_outlined,
        _compactNumber(_metrics['totalUsers']),
        'Users',
      ),
      (
        Icons.event_available_rounded,
        _compactNumber(_metrics['totalRequests']),
        'Bookings',
      ),
      (
        Icons.manage_accounts_outlined,
        _compactNumber(_metrics['pendingProviders']),
        'Pending Requests',
      ),
      (
        Icons.admin_panel_settings_outlined,
        '${_compactNumber(revenue)} ILS',
        'Revenue',
      ),
    ];
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AdminLocalizedText(
            "Today's overview",
            style: TextStyle(
              color: _palette.inkDark,
              fontSize: 14,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 9),
          Row(
            textDirection: TextDirection.ltr,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var index = 0; index < values.length; index++) ...[
                Expanded(
                  child: _dashboardKpiChip(
                    icon: values[index].$1,
                    value: values[index].$2,
                    label: values[index].$3,
                  ),
                ),
                if (index != values.length - 1) const SizedBox(width: 6),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _dashboardKpiChip({
    required IconData icon,
    required String value,
    required String label,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
      decoration: BoxDecoration(
        color: _palette.surfaceSoft,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: _darkTeal, size: 20),
          const SizedBox(height: 5),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: AdminLocalizedText(
              value,
              maxLines: 1,
              style: TextStyle(
                color: _palette.inkDark,
                fontSize: 15,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const SizedBox(height: 4),
          AdminLocalizedText(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: _palette.inkMuted,
              fontSize: 9.5,
              height: 1.15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _adminWelcomeCard() {
    final firstName = widget.user.fullName.trim().isEmpty
        ? 'Admin'
        : widget.user.fullName.trim().split(RegExp(r'\s+')).first;
    return Row(
      children: [
        Container(
          width: 82,
          height: 82,
          decoration: BoxDecoration(
            color: _palette.surfaceSoft,
            borderRadius: BorderRadius.circular(28),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Positioned(
                bottom: 8,
                child: Icon(
                  Icons.local_hospital_rounded,
                  color: _teal,
                  size: 54,
                ),
              ),
              Positioned(
                top: 12,
                child: CircleAvatar(
                  radius: 21,
                  backgroundColor: _surface,
                  child: AdminLocalizedText(
                    _initials(widget.user.fullName),
                    style: TextStyle(
                      color: _darkTeal,
                      fontSize: 15,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                'Welcome, $firstName',
                style: TextStyle(
                  color: _ink,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                ),
              ),
              SizedBox(height: 4),
              AdminLocalizedText(
                'Super Administrator',
                style: TextStyle(
                  color: _teal,
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                ),
              ),
              SizedBox(height: 7),
              Icon(Icons.verified_rounded, color: Color(0xFFFFC44D), size: 17),
            ],
          ),
        ),
      ],
    );
  }

  Widget _bookingReviewShortcut() {
    final waitingRefunds = _transactions.where((item) {
      final status = _text(item['paymentStatus']).toLowerCase();
      final escrow = _text(item['escrowStatus']).toLowerCase();
      return status.contains('refund') || escrow.contains('refund');
    }).length;
    final metrics = [
      (
        Icons.manage_accounts_outlined,
        'Pending Reviews',
        _bookingReviewItems.length,
      ),
      (Icons.currency_exchange_rounded, 'Waiting Refunds', waitingRefunds),
    ];
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: AdminLocalizedText(
                  'Booking Review',
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              IconButton(
                tooltip: context.adminTr('View All'),
                onPressed: _openBookingReview,
                icon: Icon(
                  context.adminTextDirection == TextDirection.rtl
                      ? Icons.chevron_left_rounded
                      : Icons.chevron_right_rounded,
                  color: _darkTeal,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Row(
            children: [
              for (var index = 0; index < metrics.length; index++) ...[
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    decoration: BoxDecoration(
                      color: _palette.surfaceSoft,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(metrics[index].$1, color: _darkTeal, size: 24),
                        const SizedBox(width: 8),
                        Column(
                          children: [
                            AdminLocalizedText(
                              '${metrics[index].$3}',
                              style: const TextStyle(
                                color: _darkTeal,
                                fontSize: 18,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            const SizedBox(height: 2),
                            AdminLocalizedText(
                              metrics[index].$2,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: _palette.inkMuted,
                                fontSize: 9.5,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                if (index != metrics.length - 1) const SizedBox(width: 8),
              ],
            ],
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _openBookingReview,
              icon: const Icon(Icons.arrow_forward_rounded, size: 18),
              label: const AdminLocalizedText('Open Review'),
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _dashboardMetricCard({
    required IconData icon,
    required String title,
    required String value,
    required String trend,
    required bool positive,
  }) {
    final trendColor = positive ? Color(0xFF14A56A) : Color(0xFFE03131);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: _palette.surfaceSoft,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(icon, color: _darkTeal, size: 22),
          ),
          const SizedBox(height: 12),
          AdminLocalizedText(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _palette.inkDark,
              fontSize: 22,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 4),
          AdminLocalizedText(
            title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _palette.inkMuted,
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                positive
                    ? Icons.arrow_upward_rounded
                    : Icons.arrow_downward_rounded,
                color: trendColor,
                size: 13,
              ),
              const SizedBox(width: 3),
              Flexible(
                child: AdminLocalizedText(
                  trend,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: trendColor,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _dashboardResponsivePair({
    required bool tablet,
    required Widget first,
    required Widget second,
  }) {
    if (!tablet) {
      return Column(children: [first, const SizedBox(height: 16), second]);
    }
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: first),
          const SizedBox(width: 16),
          Expanded(child: second),
        ],
      ),
    );
  }

  Widget _dashboardPanel({
    required String title,
    required Widget child,
    VoidCallback? onViewAll,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: AdminLocalizedText(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              if (onViewAll != null)
                TextButton(
                  onPressed: onViewAll,
                  child: const AdminLocalizedText('View All'),
                ),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _dashboardRevenueCard() {
    final revenue = _num(_financeOverview['totalRevenue']);
    return _dashboardPanel(
      title: 'Total Revenue',
      onViewAll: () => setState(() => _tabIndex = 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AdminLocalizedText(
            _money(revenue),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _palette.inkDark,
              fontSize: 24,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 4),
          AdminLocalizedText(
            'This Month',
            style: TextStyle(
              color: _palette.inkMuted,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 16),
          AspectRatio(
            aspectRatio: 2.2,
            child: CustomPaint(
              painter: _LineChartPainter(
                _trendPoints(revenue <= 0 ? 1 : revenue),
                _darkTeal,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _dashboardRecentActivities() {
    final items = _serviceRequests.take(3).toList();
    return _dashboardPanel(
      title: 'Recent Activities',
      onViewAll: () => setState(() => _tabIndex = 1),
      child: items.isEmpty
          ? const AdminEmptyState(message: 'No recent activities')
          : Column(
              children: [
                for (var index = 0; index < items.length; index++) ...[
                  _dashboardActivityRow(
                    items[index],
                    isLast: index == items.length - 1,
                  ),
                ],
              ],
            ),
    );
  }

  Widget _dashboardActivityRow(
    Map<String, dynamic> item, {
    required bool isLast,
  }) {
    final patient = _text(item['patientName'], fallback: 'Patient');
    return Row(
      children: [
        AdminAvatar(data: item, name: patient, size: 34),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: isLast ? 0 : 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(item['serviceType'], fallback: 'Service Request'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                AdminLocalizedText(
                  patient,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: _palette.inkMuted, fontSize: 11),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 8),
        AdminLocalizedText(
          _shortDate(item['createdAt'] ?? item['scheduledAt']),
          maxLines: 1,
          style: TextStyle(color: _palette.inkMuted, fontSize: 10),
        ),
      ],
    );
  }

  // ignore: unused_element
  Widget _dashboardPendingApprovals() {
    final pending = _requests
        .where(
          (provider) =>
              _text(provider['approvalStatus'], fallback: 'pending') ==
              'pending',
        )
        .take(6)
        .toList();
    return _dashboardPanel(
      title: 'Pending Approvals',
      onViewAll: () => setState(() => _tabIndex = 2),
      child: pending.isEmpty
          ? const AdminEmptyState(message: 'No pending provider approvals')
          : SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              physics: const BouncingScrollPhysics(),
              child: Row(
                children: [
                  for (var index = 0; index < pending.length; index++) ...[
                    SizedBox(
                      width: math.min(
                        280,
                        MediaQuery.sizeOf(context).width * .76,
                      ),
                      child: _dashboardApprovalCard(pending[index]),
                    ),
                    if (index != pending.length - 1) const SizedBox(width: 12),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _dashboardApprovalCard(Map<String, dynamic> provider) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _palette.surfaceSoft,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _palette.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _providerPhoto(provider),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      _text(provider['fullName'], fallback: 'Provider'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkDark,
                        fontSize: 13,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    AdminLocalizedText(
                      _text(provider['specialization'], fallback: 'Provider'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: _palette.inkMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              const AdminStatusBadge(status: 'pending', label: 'Pending'),
            ],
          ),
          const SizedBox(height: 8),
          AdminLocalizedText(
            _shortDate(provider['createdAt']),
            style: TextStyle(color: _palette.inkMuted, fontSize: 10.5),
          ),
          const SizedBox(height: 12),
          AdminResponsiveActions(
            children: [
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  foregroundColor: adminDanger,
                  side: const BorderSide(color: adminDanger),
                ),
                onPressed: () => _setApproval(provider, 'rejected'),
                child: const AdminLocalizedText('Reject'),
              ),
              FilledButton(
                onPressed: () => _setApproval(provider, 'approved'),
                child: const AdminLocalizedText('Approve'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _dashboardRefundList() {
    final refunds = _transactions
        .where((item) {
          final paymentStatus = _text(item['paymentStatus']).toLowerCase();
          final escrowStatus = _text(item['escrowStatus']).toLowerCase();
          return paymentStatus.contains('refund') ||
              escrowStatus.contains('refund');
        })
        .take(5)
        .toList();
    return _dashboardPanel(
      title: 'Refund Requests',
      onViewAll: () {
        setState(() {
          _tabIndex = 5;
          _financeTab = 1;
          _transactionFilter = 'refunds';
        });
      },
      child: refunds.isEmpty
          ? const AdminEmptyState(message: 'No refund requests yet')
          : Column(
              children: [
                for (var index = 0; index < refunds.length; index++) ...[
                  _dashboardRefundListRow(refunds[index]),
                  if (index != refunds.length - 1)
                    Divider(height: 20, color: _palette.stroke),
                ],
              ],
            ),
    );
  }

  Widget _dashboardRefundListRow(Map<String, dynamic> item) {
    final patient = _text(item['patientName'], fallback: 'Patient');
    final status = _text(
      item['paymentStatus'] ?? item['escrowStatus'],
      fallback: 'pending',
    );
    return Row(
      children: [
        AdminAvatar(data: item, name: patient, size: 40),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                patient,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 3),
              AdminLocalizedText(
                'Booking ${_text(item['requestId'], fallback: '-')}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: _palette.inkMuted, fontSize: 10.5),
              ),
              const SizedBox(height: 3),
              AdminLocalizedText(
                _money(item['totalAmount'] ?? item['amount']),
                style: const TextStyle(
                  color: _darkTeal,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            AdminStatusBadge(status: status, label: status),
            const SizedBox(height: 6),
            TextButton(
              onPressed: () {
                setState(() {
                  _tabIndex = 5;
                  _financeTab = 1;
                  _transactionFilter = 'refunds';
                });
              },
              child: const AdminLocalizedText('Review'),
            ),
          ],
        ),
      ],
    );
  }

  // ignore: unused_element
  Widget _dashboardLatestBookings() {
    final items = _serviceRequests.take(3).toList();
    return _dashboardPanel(
      title: 'Latest Bookings',
      onViewAll: () => setState(() => _tabIndex = 1),
      child: items.isEmpty
          ? const AdminEmptyState(message: 'No bookings yet')
          : Column(
              children: [
                for (var index = 0; index < items.length; index++) ...[
                  _dashboardBookingRow(items[index]),
                  if (index != items.length - 1)
                    Divider(height: 20, color: _palette.stroke),
                ],
              ],
            ),
    );
  }

  Widget _dashboardBookingRow(Map<String, dynamic> item) {
    final patient = _text(item['patientName'], fallback: 'Patient');
    final provider = _text(item['providerName'], fallback: 'Provider');
    final status = _text(item['status'], fallback: 'pending');
    return Row(
      children: [
        AdminAvatar(data: item, name: patient, size: 38),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                patient,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 3),
              AdminLocalizedText(
                provider,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: _palette.inkMuted, fontSize: 11),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Flexible(child: AdminStatusBadge(status: status)),
        const SizedBox(width: 4),
        Icon(
          context.adminTextDirection == TextDirection.rtl
              ? Icons.chevron_left_rounded
              : Icons.chevron_right_rounded,
          color: _palette.inkMuted,
          size: 20,
        ),
      ],
    );
  }

  // ignore: unused_element
  Widget _dashboardRefundRequests(List<Map<String, dynamic>> items) {
    return _dashboardPanel(
      title: 'Refund Requests',
      onViewAll: () {
        setState(() {
          _tabIndex = 5;
          _financeTab = 1;
          _transactionFilter = 'refunds';
        });
      },
      child: items.isEmpty
          ? const AdminEmptyState(message: 'No refund requests yet')
          : Column(
              children: [
                for (var index = 0; index < items.take(4).length; index++) ...[
                  _dashboardRefundRow(items[index]),
                  if (index != items.take(4).length - 1)
                    Divider(height: 20, color: _palette.stroke),
                ],
              ],
            ),
    );
  }

  Widget _dashboardRefundRow(Map<String, dynamic> item) {
    final patient = _text(item['patientName'], fallback: 'Patient');
    return Row(
      children: [
        AdminAvatar(data: item, name: patient, size: 38),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AdminLocalizedText(
                patient,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: _palette.inkDark,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 3),
              AdminLocalizedText(
                _money(item['totalAmount'] ?? item['amount']),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: _palette.inkMuted, fontSize: 11),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        const Flexible(
          child: AdminStatusBadge(status: 'processed', label: 'Refunded'),
        ),
      ],
    );
  }

  Widget _dashboardQuickActionsPanel() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AdminLocalizedText(
            'Quick Actions',
            style: TextStyle(
              color: _palette.inkDark,
              fontSize: 14,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 10),
          _dashboardQuickActions(),
        ],
      ),
    );
  }

  Widget _dashboardQuickActions() {
    final actions = <(IconData, String, VoidCallback)>[
      (
        Icons.person_add_alt_rounded,
        'Users',
        () => setState(() => _tabIndex = 3),
      ),
      (
        Icons.group_add_outlined,
        'Providers',
        () => setState(() => _tabIndex = 2),
      ),
      (
        Icons.receipt_long_outlined,
        'Finance',
        () => setState(() => _tabIndex = 5),
      ),
      (
        Icons.rule_folder_outlined,
        'Requests',
        () => setState(() => _tabIndex = 1),
      ),
      (
        Icons.add_circle_outline_rounded,
        'Booking Review',
        () => _openBookingReview(),
      ),
      (
        Icons.bar_chart_rounded,
        'Statistics',
        () => setState(() => _tabIndex = 6),
      ),
      (Icons.star_rounded, 'Ratings', () => setState(() => _tabIndex = 4)),
      (Icons.tune_rounded, 'Settings', () => setState(() => _tabIndex = 7)),
    ];
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: actions.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 4,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
        childAspectRatio: 1,
      ),
      itemBuilder: (context, index) {
        final action = actions[index];
        return InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: action.$3,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 7),
            decoration: BoxDecoration(
              color: _palette.surfaceSoft,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: _surface,
                    borderRadius: BorderRadius.circular(13),
                  ),
                  child: Icon(action.$1, color: _darkTeal, size: 19),
                ),
                const SizedBox(height: 7),
                AdminLocalizedText(
                  action.$2,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: _palette.inkDark,
                    fontSize: 9.5,
                    height: 1.15,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  // ignore: unused_element
  Widget _dashboardFinanceCompact() {
    final revenue = _num(_financeOverview['totalRevenue']);
    final refunds = _transactions.where((item) {
      final paymentStatus = _text(item['paymentStatus']).toLowerCase();
      final escrowStatus = _text(item['escrowStatus']).toLowerCase();
      return paymentStatus.contains('refund') ||
          escrowStatus.contains('refund');
    }).length;
    final metrics = [
      ('Revenue', _money(revenue)),
      ('Bookings', _compactNumber(_metrics['totalRequests'])),
      ('Refunds', _compactNumber(refunds)),
      ('Monthly Income', _money(_financeOverview['platformProfit'])),
    ];
    return _dashboardPanel(
      title: 'Finance Overview',
      onViewAll: () => setState(() => _tabIndex = 5),
      child: Column(
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var index = 0; index < metrics.length; index++) ...[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AdminLocalizedText(
                        metrics[index].$1,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: _palette.inkMuted,
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 5),
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: AlignmentDirectional.centerStart,
                        child: AdminLocalizedText(
                          metrics[index].$2,
                          maxLines: 1,
                          style: TextStyle(
                            color: _palette.inkDark,
                            fontSize: 14,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                if (index != metrics.length - 1)
                  Container(
                    width: 1,
                    height: 42,
                    margin: const EdgeInsets.symmetric(horizontal: 5),
                    color: _palette.stroke,
                  ),
              ],
            ],
          ),
          const SizedBox(height: 14),
          AspectRatio(
            aspectRatio: 2.8,
            child: CustomPaint(
              painter: _LineChartPainter(
                _trendPoints(revenue <= 0 ? 1 : revenue),
                _darkTeal,
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _financeOverviewCard() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const AdminLocalizedText(
                'Finance Overview (Escrow)',
                style: TextStyle(
                  color: _ink,
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const Spacer(),
              AdminLocalizedText(
                'This Month',
                style: TextStyle(
                  color: Colors.grey.shade600,
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(width: 4),
              const Icon(
                Icons.keyboard_arrow_down_rounded,
                color: _muted,
                size: 18,
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: _financeMini(
                  'Total Revenue (Paid)',
                  _money(_financeOverview['totalRevenue']),
                  '+ 10%',
                  true,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _financeMini(
                  'Paid to Providers',
                  _money(_financeOverview['releasedToProviders']),
                  '+ 5%',
                  true,
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: _financeMini(
                  'Platform Profit',
                  _money(_financeOverview['platformProfit']),
                  '+ 4%',
                  true,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _financeMini(
                  'Pending Escrow',
                  _money(_financeOverview['pendingEscrow']),
                  '+ 5%',
                  false,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _financeMini(String label, String value, String trend, bool positive) {
    final trendColor = positive
        ? const Color(0xFF14A56A)
        : const Color(0xFFB9770E);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AdminLocalizedText(
          label,
          style: const TextStyle(
            color: Color(0xFF7C8A8F),
            fontSize: 10.5,
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 7),
        AdminLocalizedText(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: _ink,
            fontSize: 14,
            fontWeight: FontWeight.w900,
          ),
        ),
        const SizedBox(height: 5),
        Row(
          children: [
            Icon(
              positive
                  ? Icons.arrow_upward_rounded
                  : Icons.warning_amber_rounded,
              color: trendColor,
              size: 13,
            ),
            const SizedBox(width: 3),
            AdminLocalizedText(
              trend,
              style: TextStyle(
                color: trendColor,
                fontSize: 10.5,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ),
      ],
    );
  }

  // ignore: unused_element
  Widget _requestsByStatusCard() {
    final completed = _int(_metrics['completedRequests']);
    final pending = _int(_metrics['pendingRequests']);
    final cancelled = _int(_metrics['cancelledRequests']);
    final total = _int(_metrics['totalRequests']);
    final inProgress = (total - completed - pending - cancelled).clamp(
      0,
      total,
    );
    final slices = [
      _StatusSlice('Completed', completed, const Color(0xFF00A887)),
      _StatusSlice('In Progress', inProgress, const Color(0xFF1B8CFF)),
      _StatusSlice('Pending', pending, const Color(0xFFFFC107)),
      _StatusSlice('Cancelled', cancelled, const Color(0xFFE53935)),
    ];
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const AdminLocalizedText(
            'Requests by Status',
            style: TextStyle(
              color: _ink,
              fontSize: 13,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              SizedBox(
                width: 132,
                height: 132,
                child: CustomPaint(
                  painter: _DonutChartPainter(slices),
                  child: Center(
                    child: AdminLocalizedText(
                      _compactNumber(total),
                      style: const TextStyle(
                        color: _ink,
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 18),
              Expanded(
                child: Column(
                  children: slices
                      .map((slice) => _statusLegend(slice, total))
                      .toList(),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _statisticsPage() {
    final filteredUsers = _statsRows(_users, const ['createdAt']);
    final users = filteredUsers.isEmpty ? _users : filteredUsers;
    final requests = _statsRows(_serviceRequests, const [
      'scheduledAt',
      'createdAt',
    ]);
    final ratings = _statsRows(_ratings, const ['createdAt']);
    final transactions = _statsRows(_transactions, const ['createdAt']);
    final payouts = _statsRows(_payouts, const ['createdAt']);
    final reviews = _statsRows(_bookingReviewItems, const [
      'scheduledAt',
      'createdAt',
    ]);
    final totalProviders = users
        .where((u) => ['nurse', 'doctor'].contains(_text(u['role'])))
        .length;
    final totalPatients = users
        .where((u) => _text(u['role']) == 'patient')
        .length;
    final totalRevenue = transactions.fold<double>(
      0,
      (sum, item) => sum + _num(item['totalAmount'] ?? item['amount']),
    );
    final averageRating = ratings.isEmpty
        ? 0.0
        : ratings.fold<double>(0, (sum, item) => sum + _num(item['stars'])) /
              ratings.length;
    final totalSessions = requests.length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 28),
      children: [
        _statisticsTopBar(),
        const SizedBox(height: 14),
        _statisticsFiltersCard(),
        const SizedBox(height: 14),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: 1.42,
          children: [
            _statisticsMetricCard(
              icon: Icons.groups_rounded,
              iconColor: const Color(0xFF16A34A),
              iconBg: const Color(0xFFE6F8EC),
              title: 'Total Users',
              value: _compactNumber(users.length),
              trend: '12%',
            ),
            _statisticsMetricCard(
              icon: Icons.medical_services_outlined,
              iconColor: const Color(0xFF147AD6),
              iconBg: const Color(0xFFE8F2FF),
              title: 'Total Providers',
              value: _compactNumber(totalProviders),
              trend: '8%',
            ),
            _statisticsMetricCard(
              icon: Icons.person_outline_rounded,
              iconColor: const Color(0xFF9333EA),
              iconBg: const Color(0xFFF3E8FF),
              title: 'Total Patients',
              value: _compactNumber(totalPatients),
              trend: '10%',
            ),
            _statisticsMetricCard(
              icon: Icons.calendar_month_rounded,
              iconColor: const Color(0xFFF97316),
              iconBg: const Color(0xFFFFF1E6),
              title: 'Total Sessions',
              value: _compactNumber(totalSessions),
              trend: '15%',
            ),
            _statisticsMetricCard(
              icon: Icons.paid_outlined,
              iconColor: const Color(0xFFEAB308),
              iconBg: const Color(0xFFFFF8DB),
              title: 'Total Revenue',
              value: _money(totalRevenue),
              trend: '10%',
            ),
            _statisticsMetricCard(
              icon: Icons.star_rounded,
              iconColor: const Color(0xFF0F766E),
              iconBg: const Color(0xFFE0F5F2),
              title: 'Average Rating',
              value: '${averageRating.toStringAsFixed(1)} / 5',
              trend: '5%',
            ),
          ],
        ),
        const SizedBox(height: 14),
        _statisticsRevenueCard(totalRevenue),
        const SizedBox(height: 14),
        _statisticsSessionsCard(requests, reviews),
        const SizedBox(height: 14),
        _statisticsServicesCard(requests),
        const SizedBox(height: 14),
        _statisticsTopProvidersCard(payouts),
        const SizedBox(height: 14),
        _statisticsRatingCard(ratings),
        const SizedBox(height: 14),
        _statisticsPaymentCard(transactions, payouts, reviews),
      ],
    );
  }

  Widget _statisticsTopBar() {
    return AdminPageHeader(
      title: 'Statistics',
      subtitle: 'Overview & key metrics',
      onBack: () => setState(() => _tabIndex = 0),
      onRefresh: _load,
    );
  }

  Widget _statisticsFiltersCard() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          _statisticsRangeButton(),
          const Spacer(),
          _statisticsFilterButton(Icons.filter_list_rounded, 'Filters'),
        ],
      ),
    );
  }

  Widget _statisticsRangeButton() {
    return PopupMenuButton<String>(
      initialValue: _statisticsRange,
      onSelected: (value) => setState(() => _statisticsRange = value),
      itemBuilder: (context) => const [
        PopupMenuItem(
          value: 'This Month',
          child: AdminLocalizedText('This Month'),
        ),
        PopupMenuItem(
          value: 'This Week',
          child: AdminLocalizedText('This Week'),
        ),
        PopupMenuItem(
          value: 'This Year',
          child: AdminLocalizedText('This Year'),
        ),
      ],
      child: _statisticsFilterButton(
        Icons.calendar_month_outlined,
        _statisticsRange,
        showArrow: true,
      ),
    );
  }

  Widget _statisticsFilterButton(
    IconData icon,
    String label, {
    bool showArrow = false,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _palette.stroke),
      ),
      child: Row(
        children: [
          Icon(icon, color: _palette.inkDark, size: 18),
          const SizedBox(width: 8),
          AdminLocalizedText(
            label,
            style: const TextStyle(
              color: _ink,
              fontSize: 12,
              fontWeight: FontWeight.w900,
            ),
          ),
          if (showArrow) ...[
            const SizedBox(width: 5),
            const Icon(Icons.keyboard_arrow_down_rounded, size: 16),
          ],
        ],
      ),
    );
  }

  Widget _statisticsMetricCard({
    required IconData icon,
    required Color iconColor,
    required Color iconBg,
    required String title,
    required String value,
    required String trend,
  }) {
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: iconBg, shape: BoxShape.circle),
            child: Icon(icon, color: iconColor, size: 24),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: _ink,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                AdminLocalizedText(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    const Icon(
                      Icons.arrow_upward_rounded,
                      color: Color(0xFF16A34A),
                      size: 12,
                    ),
                    const SizedBox(width: 3),
                    AdminLocalizedText(
                      trend,
                      style: const TextStyle(
                        color: Color(0xFF16A34A),
                        fontSize: 10,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Expanded(
                      child: AdminLocalizedText(
                        'from last month',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: _muted,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _statisticsRevenueCard(double revenue) {
    final points = _trendPoints(revenue <= 0 ? 23850 : revenue);
    return _statisticsPanel(
      title: 'Revenue Overview',
      trailing: _smallSelect('Monthly'),
      child: SizedBox(
        height: 170,
        child: CustomPaint(
          painter: _LineChartPainter(points, _teal),
          child: Align(
            alignment: Alignment.bottomRight,
            child: Padding(
              padding: const EdgeInsets.only(right: 12, bottom: 38),
              child: Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: _teal,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: AdminLocalizedText(
                  'This Month\n${_money(revenue)}',
                  style: TextStyle(
                    color: _onPrimary,
                    fontSize: 10,
                    height: 1.3,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _statisticsSessionsCard(
    List<Map<String, dynamic>> requests,
    List<Map<String, dynamic>> reviews,
  ) {
    final completed = requests
        .where((r) => _serviceStatusGroup(_text(r['status'])) == 'completed')
        .length;
    final pending = requests
        .where((r) => _serviceStatusGroup(_text(r['status'])) == 'pending')
        .length;
    final cancelled = requests
        .where((r) => _serviceStatusGroup(_text(r['status'])) == 'cancelled')
        .length;
    final total = requests.length;
    final noShow = reviews.length;
    final slices = [
      _StatusSlice('Completed', completed, _teal),
      _StatusSlice('Pending', pending, const Color(0xFFFFC107)),
      _StatusSlice('Cancelled', cancelled, const Color(0xFFE53935)),
      _StatusSlice('No Show', noShow, const Color(0xFFB5C0CA)),
    ];
    return _statisticsPanel(
      title: 'Sessions Statistics',
      child: Row(
        children: [
          SizedBox(
            width: 132,
            height: 132,
            child: CustomPaint(painter: _DonutChartPainter(slices)),
          ),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              children: slices
                  .map((slice) => _statusLegend(slice, total + noShow))
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _statisticsServicesCard(List<Map<String, dynamic>> requests) {
    final counts = <String, int>{};
    for (final request in requests) {
      final name = _text(request['serviceType'], fallback: 'Home Nursing Care');
      counts[name] = (counts[name] ?? 0) + 1;
    }
    final entries = counts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final top = entries.isEmpty
        ? [
            const MapEntry('Elderly Care', 35),
            const MapEntry('Home Nursing Care', 25),
            const MapEntry('Wound Care', 10),
          ]
        : entries.take(5).toList();
    final maxValue = top.map((e) => e.value).fold<int>(1, math.max);
    return _statisticsPanel(
      title: 'Most Requested Services',
      trailing: _smallSelect('Top 5'),
      child: Column(
        children: [
          for (final item in top)
            _serviceBarRow(item.key, item.value, maxValue),
        ],
      ),
    );
  }

  Widget _statisticsTopProvidersCard(List<Map<String, dynamic>> payouts) {
    final providers = payouts.isNotEmpty ? payouts : <Map<String, dynamic>>[];
    return _statisticsPanel(
      title: 'Top Providers Performance',
      trailing: TextButton(
        onPressed: () => setState(() => _tabIndex = 2),
        child: const AdminLocalizedText('View All'),
      ),
      child: Column(
        children: [
          for (final item in providers.take(5))
            _topProviderRow(
              name: _text(item['providerName'], fallback: 'Provider'),
              subtitle: _text(
                item['specialization'],
                fallback: 'Care Provider',
              ),
              sessions: _int(item['completedSessions'] ?? item['sessions']),
              rating: _num(item['rating'] ?? _metrics['averageStars']),
              earnings: _money(item['netAmount'] ?? item['balance'] ?? 0),
            ),
          if (providers.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: AdminLocalizedText(
                'Provider performance appears here after completed sessions.',
                style: TextStyle(color: _muted, fontWeight: FontWeight.w700),
              ),
            ),
        ],
      ),
    );
  }

  Widget _statisticsRatingCard(List<Map<String, dynamic>> ratings) {
    final total = ratings.length;
    final five = ratings.where((r) => _int(r['stars']) >= 5).length;
    final four = ratings.where((r) => _int(r['stars']) == 4).length;
    final three = ratings.where((r) => _int(r['stars']) == 3).length;
    final low = ratings.where((r) => _int(r['stars']) <= 2).length;
    final slices = [
      _StatusSlice('5 Stars', five, _teal),
      _StatusSlice('4 Stars', four, const Color(0xFFFFC107)),
      _StatusSlice('3 Stars', three, const Color(0xFFE53935)),
      _StatusSlice('2-1 Stars', low, const Color(0xFFB5C0CA)),
    ];
    return _statisticsPanel(
      title: 'Rating Statistics',
      child: Row(
        children: [
          SizedBox(
            width: 118,
            height: 118,
            child: CustomPaint(painter: _DonutChartPainter(slices)),
          ),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              children: slices.map((s) => _statusLegend(s, total)).toList(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _statisticsPaymentCard(
    List<Map<String, dynamic>> transactions,
    List<Map<String, dynamic>> payouts,
    List<Map<String, dynamic>> reviews,
  ) {
    final platformProfit = transactions.fold<double>(
      0,
      (sum, item) => sum + _num(item['adminShare']),
    );
    return _statisticsPanel(
      title: 'Payment Statistics',
      child: GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        childAspectRatio: 1.35,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        children: [
          _paymentStat(
            Icons.payments_outlined,
            'Payments Completed',
            _compactNumber(transactions.length),
            const Color(0xFF16A34A),
          ),
          _paymentStat(
            Icons.replay_rounded,
            'Refunds',
            _compactNumber(reviews.length),
            const Color(0xFF9333EA),
          ),
          _paymentStat(
            Icons.pending_actions_rounded,
            'Pending Payouts',
            _compactNumber(payouts.length),
            const Color(0xFFF97316),
          ),
          _paymentStat(
            Icons.account_balance_wallet_outlined,
            'Platform Profit',
            _money(platformProfit),
            _teal,
          ),
        ],
      ),
    );
  }

  Widget _statisticsPanel({
    required String title,
    Widget? trailing,
    required Widget child,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: AdminLocalizedText(
                  title,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 15,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }

  Widget _smallSelect(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _palette.stroke),
      ),
      child: Row(
        children: [
          AdminLocalizedText(
            label,
            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w900),
          ),
          const Icon(Icons.keyboard_arrow_down_rounded, size: 14),
        ],
      ),
    );
  }

  Widget _serviceBarRow(String label, int value, int maxValue) {
    final percent = maxValue <= 0 ? 0.0 : value / maxValue;
    return Padding(
      padding: const EdgeInsets.only(bottom: 13),
      child: Row(
        children: [
          Expanded(
            flex: 5,
            child: AdminLocalizedText(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: _ink,
                fontSize: 11,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 6,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: percent.clamp(0.0, 1.0),
                minHeight: 10,
                backgroundColor: const Color(0xFFEAF0F2),
                valueColor: const AlwaysStoppedAnimation<Color>(_teal),
              ),
            ),
          ),
          const SizedBox(width: 8),
          AdminLocalizedText(
            '$value',
            style: const TextStyle(
              color: _ink,
              fontSize: 11,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }

  Widget _topProviderRow({
    required String name,
    required String subtitle,
    required int sessions,
    required double rating,
    required String earnings,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 13),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: _teal.withValues(alpha: 0.14),
            child: AdminLocalizedText(
              _initials(name),
              style: const TextStyle(
                color: _teal,
                fontSize: 11,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 12,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                AdminLocalizedText(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _muted,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          AdminLocalizedText(
            '$sessions',
            style: const TextStyle(fontWeight: FontWeight.w900),
          ),
          const SizedBox(width: 14),
          Row(
            children: [
              const Icon(
                Icons.star_rounded,
                color: Color(0xFFFFC107),
                size: 14,
              ),
              AdminLocalizedText(
                rating.toStringAsFixed(1),
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(width: 14),
          AdminLocalizedText(
            earnings,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w900),
          ),
        ],
      ),
    );
  }

  Widget _paymentStat(IconData icon, String label, String value, Color color) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: _palette.surfaceSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 8),
          AdminLocalizedText(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: _muted,
              fontSize: 10,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          AdminLocalizedText(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: _ink,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }

  List<double> _trendPoints(double target) {
    final base = target <= 0 ? 1000.0 : target / 8;
    return [
      base,
      base * 2.6,
      base * 4.2,
      base * 2.8,
      base * 5.8,
      base * 5.0,
      base * 7.4,
      target,
    ];
  }

  Widget _statusLegend(_StatusSlice slice, int total) {
    final percent = total <= 0 ? 0 : ((slice.value / total) * 100).round();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: slice.color,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: AdminLocalizedText(
              slice.label,
              style: const TextStyle(
                color: _ink,
                fontSize: 11,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          AdminLocalizedText(
            '${slice.value} ($percent%)',
            style: const TextStyle(
              color: _muted,
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _statCard(String title, String value, String badge) {
    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _line),
        boxShadow: _shadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          AdminLocalizedText(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: _muted, fontSize: 12),
          ),
          const SizedBox(height: 6),
          AdminLocalizedText(
            value,
            style: const TextStyle(
              color: _ink,
              fontSize: 23,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: _pill(badge, const Color(0xFFE7FAF4), _teal),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _performancePanel() {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: _teal,
        borderRadius: BorderRadius.circular(24),
        boxShadow: _shadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Row(
            children: [
              Icon(Icons.monitor_heart_rounded, color: _onPrimary),
              Spacer(),
              AdminLocalizedText(
                'Performance Indicators',
                style: TextStyle(
                  color: _onPrimary,
                  fontSize: 16,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              _miniPerf('Completed Requests', _n('completedRequests')),
              const SizedBox(width: 8),
              _miniPerf('Average Rating', _decimal('averageStars')),
              const SizedBox(width: 8),
              _miniPerf('Pending Requests', _n('pendingRequests')),
            ],
          ),
        ],
      ),
    );
  }

  Widget _miniPerf(String label, String value) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: _onPrimary.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(18),
        ),
        child: Column(
          children: [
            AdminLocalizedText(
              value,
              style: TextStyle(
                color: _onPrimary,
                fontWeight: FontWeight.w900,
                fontSize: 17,
              ),
            ),
            const SizedBox(height: 5),
            AdminLocalizedText(
              label,
              style: TextStyle(color: _onPrimary, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _requestCard(Map<String, dynamic> item) {
    final status = _text(item['approvalStatus'], fallback: 'pending');
    final role = _text(item['role']);
    final total = _int(item['certificationCount']);
    final verified = _int(item['verifiedCertificationCount']);
    final documents = _int(item['documentCount']);
    final tier = _text(item['experienceTier'], fallback: 'junior');
    return _whitePanel(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          children: [
            Row(
              children: [
                _avatar(_initials(item['fullName']), _roleColor(role)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      AdminLocalizedText(
                        _text(item['fullName']),
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      AdminLocalizedText(
                        '${_roleLabel(role)} - ${_text(item['specialization'])}',
                        style: const TextStyle(color: _muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                _pill(
                  _statusLabel(status),
                  _statusBg(status),
                  _statusFg(status),
                ),
              ],
            ),
            const Divider(height: 24, color: _line),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              alignment: WrapAlignment.spaceBetween,
              children: [
                _smallMeta(
                  Icons.location_on_outlined,
                  _text(item['providerAddress'], fallback: 'Not set'),
                ),
                _smallMeta(
                  Icons.workspace_premium_outlined,
                  '$verified of $total certificates',
                ),
                _smallMeta(Icons.description_outlined, '$documents docs'),
                _smallMeta(Icons.trending_up_rounded, tier.toUpperCase()),
              ],
            ),
            const SizedBox(height: 12),
            AdminResponsiveActions(
              children: [
                OutlinedButton(
                  onPressed: () => _showCertifications(item),
                  child: const AdminLocalizedText('Certificates'),
                ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: adminDanger,
                    side: const BorderSide(color: adminDanger),
                  ),
                  onPressed: status == 'rejected'
                      ? null
                      : () => _setApproval(item, 'rejected'),
                  child: const AdminLocalizedText('Reject'),
                ),
                FilledButton(
                  onPressed: status == 'approved'
                      ? null
                      : () => _setApproval(item, 'approved'),
                  child: const AdminLocalizedText('Approve'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _providersTopBar() {
    return _directoryHeader('Providers');
  }

  Widget _directoryHeader(String title) {
    return SizedBox(
      height: 52,
      child: Row(
        children: [
          SizedBox(
            width: 82,
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: IconButton(
                tooltip: context.adminTr('Back'),
                onPressed: () => setState(() => _tabIndex = 0),
                icon: Icon(
                  context.adminBackIcon,
                  color: _palette.inkDark,
                  size: 25,
                ),
              ),
            ),
          ),
          Expanded(
            child: AdminLocalizedText(
              title,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: _palette.inkDark,
                fontSize: 20,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          SizedBox(
            width: 82,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                CarelinkLocaleIconButton(color: _teal),
                CarelinkThemeIconButton(color: _teal),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _directorySearchField({
    required String hint,
    required ValueChanged<String> onChanged,
  }) {
    return SizedBox(
      height: 50,
      child: TextField(
        onChanged: onChanged,
        style: TextStyle(color: _palette.inkDark, fontSize: 14),
        decoration: InputDecoration(
          hintText: context.adminTr(hint),
          hintStyle: TextStyle(
            color: _palette.inkMuted.withValues(alpha: .72),
            fontSize: 13.5,
            fontWeight: FontWeight.w600,
          ),
          prefixIcon: Icon(
            Icons.search_rounded,
            color: _palette.inkMuted,
            size: 21,
          ),
          prefixIconConstraints: const BoxConstraints(minWidth: 48),
          filled: true,
          fillColor: _surface,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(15),
            borderSide: BorderSide(color: _palette.stroke),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(15),
            borderSide: BorderSide(color: _palette.stroke),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(15),
            borderSide: const BorderSide(color: _teal, width: 1.4),
          ),
        ),
      ),
    );
  }

  Widget _providerStatusTabs() {
    final options = [
      ('all', 'All', _requests.length),
      (
        'pending',
        'Pending',
        _requests
            .where(
              (r) =>
                  _text(r['approvalStatus'], fallback: 'pending') == 'pending',
            )
            .length,
      ),
      (
        'approved',
        'Approved',
        _requests
            .where(
              (r) =>
                  _text(r['approvalStatus'], fallback: 'pending') == 'approved',
            )
            .length,
      ),
      (
        'rejected',
        'Rejected',
        _requests
            .where(
              (r) =>
                  _text(r['approvalStatus'], fallback: 'pending') == 'rejected',
            )
            .length,
      ),
    ];
    return Row(
      children: [
        for (var index = 0; index < options.length; index++) ...[
          if (index > 0) const SizedBox(width: 7),
          Expanded(
            child: _providerStatusChip(options[index].$1, options[index].$2),
          ),
        ],
      ],
    );
  }

  Widget _providerStatusChip(String value, String label) {
    final selected = _providerFilter == value;
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: () => setState(() => _providerFilter = value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
        decoration: BoxDecoration(
          color: selected ? _teal : _palette.surfaceSoft,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? _teal : _palette.stroke),
        ),
        child: AdminLocalizedText(
          label,
          style: TextStyle(
            color: selected ? _onPrimary : _teal,
            fontSize: 12,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  Widget _providerRequestTile(Map<String, dynamic> provider) {
    final role = _text(provider['role']);
    final status = _text(provider['approvalStatus'], fallback: 'pending');
    final specialty = _text(
      provider['specialization'],
      fallback: _text(provider['serviceType'], fallback: _roleLabel(role)),
    );
    return Material(
      color: _surface,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: status == 'pending'
            ? () => _showProviderReview(provider)
            : () => _showProviderDetails(provider),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _providerPhoto(provider),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      _text(provider['fullName']),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkDark,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    AdminLocalizedText(
                      specialty,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkMuted,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    AdminLocalizedText(
                      _roleLabel(role),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: _palette.inkMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _providerStatusPill(status),
              const SizedBox(width: 3),
              Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: _palette.inkMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _providerPhoto(Map<String, dynamic> provider) {
    return AdminAvatar(
      data: provider,
      name: _text(provider['fullName'], fallback: 'Provider'),
      size: 54,
      icon: Icons.medical_services_rounded,
    );
  }

  Widget _providerStatusPill(String status) {
    return AdminStatusBadge(
      status: status,
      label: status == 'approved'
          ? 'Approved'
          : status == 'pending'
          ? 'Pending'
          : 'Rejected',
    );
  }

  // ignore: unused_element
  Widget _userCard(Map<String, dynamic> user) {
    final active = user['isActive'] == true;
    final role = _text(user['role']);
    return _whitePanel(
      child: Column(
        children: [
          ListTile(
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 14,
              vertical: 8,
            ),
            leading: PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert_rounded),
              onSelected: (value) {
                if (value == 'edit') _editUser(user);
              },
              itemBuilder: (context) => const [
                PopupMenuItem(
                  value: 'edit',
                  child: AdminLocalizedText('Edit details'),
                ),
              ],
            ),
            title: AdminLocalizedText(
              _text(user['fullName']),
              textAlign: TextAlign.right,
              style: const TextStyle(fontWeight: FontWeight.w900),
            ),
            subtitle: AdminLocalizedText(
              '${_roleLabel(role)} - ${_text(user['email'])}\n${_text(user['phone'])}',
              textAlign: TextAlign.right,
            ),
            trailing: _avatar(_initials(user['fullName']), _roleColor(role)),
            isThreeLine: true,
            horizontalTitleGap: 10,
            onTap: () => _editUser(user),
            dense: false,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
            ),
            minLeadingWidth: 34,
            visualDensity: VisualDensity.compact,
            enabled: true,
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: Row(
              children: [
                Switch(
                  value: active,
                  activeThumbColor: _teal,
                  onChanged: (value) => _setUserActive(user, value),
                ),
                const Spacer(),
                _pill(
                  active ? 'Active' : 'Disabled',
                  active ? const Color(0xFFE3F8EF) : const Color(0xFFFFE6ED),
                  active ? const Color(0xFF1E9D69) : const Color(0xFFD83A59),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _usersTopBar() {
    return _directoryHeader('Users');
  }

  Widget _usersRoleTabs() {
    final options = [
      ('all', 'All', _users.length),
      (
        'patient',
        'Patients',
        _users.where((u) => _text(u['role']) == 'patient').length,
      ),
      (
        'nurse',
        'Nurses',
        _users.where((u) => _text(u['role']) == 'nurse').length,
      ),
      (
        'doctor',
        'Doctors',
        _users.where((u) => _text(u['role']) == 'doctor').length,
      ),
    ];
    return Row(
      children: [
        for (var index = 0; index < options.length; index++) ...[
          if (index > 0) const SizedBox(width: 7),
          Expanded(child: _userRoleChip(options[index].$1, options[index].$2)),
        ],
      ],
    );
  }

  Widget _userRoleChip(String value, String label) {
    final selected = _userFilter == value;
    return InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: () => setState(() => _userFilter = value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
        decoration: BoxDecoration(
          color: selected ? _teal : _surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? _teal : _palette.stroke),
          boxShadow: selected ? _softDashboardShadow : null,
        ),
        child: AdminLocalizedText(
          label,
          style: TextStyle(
            color: selected ? _onPrimary : _palette.inkDark,
            fontSize: 12,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  Widget _userListRow(Map<String, dynamic> user) {
    final active = user['isActive'] == true;
    final role = _text(user['role']);
    return Material(
      color: _surface,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => _editUser(user),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: _palette.stroke),
            boxShadow: _softDashboardShadow,
          ),
          child: Row(
            children: [
              AdminAvatar(
                data: user,
                name: _text(user['fullName'], fallback: 'User'),
                size: 54,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      _text(user['fullName']),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkDark,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    AdminLocalizedText(
                      _text(user['email']),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkMuted,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    AdminLocalizedText(
                      _roleLabel(role),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: _palette.inkMuted,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              AdminStatusBadge(
                status: active ? 'approved' : 'rejected',
                label: active ? 'Active' : 'Inactive',
              ),
              const SizedBox(width: 3),
              Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: _palette.inkMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _ratingCard(Map<String, dynamic> rating) {
    final stars = _int(rating['stars']);
    return InkWell(
      borderRadius: BorderRadius.circular(15),
      onTap: () => _showRatingDetails(rating),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: _palette.stroke),
          boxShadow: _softDashboardShadow,
        ),
        child: Row(
          textDirection: TextDirection.ltr,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AdminAvatar(
              data: rating,
              name: _text(rating['patientName'], fallback: 'Patient'),
              size: 40,
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: AdminLocalizedText(
                          _text(rating['providerName'], fallback: 'Provider'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: _palette.inkDark,
                            fontSize: 11.5,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ),
                      AdminLocalizedText(
                        _shortDate(rating['createdAt']),
                        style: TextStyle(
                          color: _palette.inkMuted,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  AdminLocalizedText(
                    _text(rating['serviceType'], fallback: 'Service'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: _palette.inkMuted,
                      fontSize: 9.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 3),
                  _stars(stars, size: 13),
                  const SizedBox(height: 3),
                  AdminLocalizedText(
                    _text(rating['comment'], fallback: 'No written notes.'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: _palette.inkDark,
                      height: 1.25,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _servicePricingTile(Map<String, dynamic> item) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 22,
            backgroundColor: _teal.withValues(alpha: 0.13),
            child: Icon(
              _text(item['providerRole']) == 'doctor'
                  ? Icons.medical_services_outlined
                  : Icons.local_hospital_outlined,
              color: _teal,
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(item['specialization'], fallback: 'Service'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  _text(item['providerName'], fallback: 'General consultation'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF718388),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          AdminLocalizedText(
            _money(item['patientPrice']),
            style: const TextStyle(
              color: _ink,
              fontSize: 12.5,
              fontWeight: FontWeight.w900,
            ),
          ),
          IconButton(
            tooltip: context.adminTr('Edit pricing'),
            onPressed: () => _editPricing(item),
            icon: const Icon(Icons.edit_rounded, color: _teal, size: 19),
          ),
        ],
      ),
    );
  }

  Widget _financeTransactionTile(Map<String, dynamic> item) {
    final status = _text(item['escrowStatus'], fallback: 'pending');
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          AdminAvatar(
            data: item,
            name: _text(item['providerName'], fallback: 'Provider'),
            size: 44,
            icon: Icons.medical_services_rounded,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(item['providerName'], fallback: 'Provider'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  'Patient: ${_text(item['patientName'], fallback: '-')}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF718388),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 5),
                AdminLocalizedText(
                  _shortDate(item['createdAt']),
                  style: const TextStyle(
                    color: Color(0xFF9AA8AB),
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              AdminLocalizedText(
                _money(item['totalAmount']),
                style: const TextStyle(
                  color: _ink,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 8),
              _financeSmallStatus(
                status == 'transferred_to_provider'
                    ? 'Paid to Nurse'
                    : status == 'paid_to_admin'
                    ? 'Held Wallet'
                    : 'Pending',
              ),
              TextButton(
                onPressed: () => _showPaymentReceipt(item),
                style: TextButton.styleFrom(
                  foregroundColor: _teal,
                  visualDensity: VisualDensity.compact,
                  textStyle: const TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                child: const AdminLocalizedText('Receipt'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _paymentRequestTile(Map<String, dynamic> item) {
    final status = _text(item['status'], fallback: 'requested').toLowerCase();
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Row(
        children: [
          AdminAvatar(
            data: item,
            name: _text(item['providerName'], fallback: 'Provider'),
            size: 46,
            icon: Icons.medical_services_rounded,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(item['providerName'], fallback: 'Provider'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  '${_int(item['completedSessions'])} Points',
                  style: const TextStyle(
                    color: Color(0xFF718388),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  _money(item['amount']),
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                AdminLocalizedText(
                  'Requested on ${_shortDate(item['createdAt'])}',
                  style: const TextStyle(
                    color: Color(0xFF9AA8AB),
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              _financeSmallStatus(
                status == 'paid'
                    ? 'Approved'
                    : status == 'rejected'
                    ? 'Rejected'
                    : 'Pending',
              ),
              const SizedBox(height: 10),
              if (status == 'requested' || status == 'approved')
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: _teal,
                    foregroundColor: _onPrimary,
                    visualDensity: VisualDensity.compact,
                    textStyle: const TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  onPressed: () => _showPayoutApproval(item),
                  child: const AdminLocalizedText('Review'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _earningsDetailsTile(Map<String, dynamic> item) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _palette.stroke),
        boxShadow: _softDashboardShadow,
      ),
      child: Column(
        children: [
          Row(
            children: [
              AdminAvatar(
                data: item,
                name: _text(item['providerName'], fallback: 'Provider'),
                size: 46,
                icon: Icons.medical_services_rounded,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AdminLocalizedText(
                      _text(item['providerName'], fallback: 'Provider'),
                      style: const TextStyle(
                        color: _ink,
                        fontSize: 13.5,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    AdminLocalizedText(
                      _text(item['providerRole'], fallback: 'Nurse'),
                      style: const TextStyle(
                        color: Color(0xFF718388),
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              _financeSmallStatus('Active'),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _moneyColumn('Total Earnings', item['totalEarned']),
              _moneyColumn('Pending Payout', item['pendingAmount']),
              _moneyColumn('Paid Out', item['paidAmount']),
            ],
          ),
        ],
      ),
    );
  }

  Widget _financeSmallStatus(String text) {
    final lower = text.toLowerCase();
    return AdminStatusBadge(
      status: lower.contains('reject')
          ? 'rejected'
          : lower.contains('pending') || lower.contains('held')
          ? 'pending'
          : lower.contains('paid') || lower.contains('transfer')
          ? 'processed'
          : 'approved',
      label: text,
    );
  }

  // ignore: unused_element
  Widget _pricingCard(Map<String, dynamic> item) {
    final status = _text(item['rateAcceptanceStatus'], fallback: 'pending');
    return _whitePanel(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Row(
              children: [
                IconButton(
                  tooltip: context.adminTr('Edit pricing'),
                  onPressed: () => _editPricing(item),
                  icon: const Icon(Icons.edit_rounded, color: _teal),
                ),
                const Spacer(),
                Expanded(
                  child: AdminLocalizedText(
                    _text(
                      item['providerName'],
                      fallback: 'Unassigned provider',
                    ),
                    textAlign: TextAlign.right,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                ),
                const SizedBox(width: 8),
                _pill(
                  _rateStatusLabel(status),
                  _statusBg(status == 'accepted' ? 'approved' : status),
                  _statusFg(status == 'accepted' ? 'approved' : status),
                ),
              ],
            ),
            const SizedBox(height: 8),
            AdminLocalizedText(
              '${_roleLabel(_text(item['providerRole']))} - ${_text(item['specialization'], fallback: 'Service')}',
              style: const TextStyle(color: _muted, fontSize: 12),
            ),
            const Divider(height: 22, color: _line),
            Row(
              children: [
                _moneyColumn('Provider Rate', item['providerRate']),
                _moneyColumn('Admin Commission', item['adminCommission']),
                _moneyColumn('Patient Price', item['patientPrice']),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _payoutCard(Map<String, dynamic> item) {
    final status = _text(item['status'], fallback: 'requested').toLowerCase();
    final actionable = status == 'requested' || status == 'approved';
    return _whitePanel(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Row(
              children: [
                _pill(status, const Color(0xFFE7FAF4), _teal),
                const Spacer(),
                Expanded(
                  child: AdminLocalizedText(
                    _text(item['providerName'], fallback: 'Provider'),
                    textAlign: TextAlign.right,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            AdminLocalizedText(
              '${_money(item['amount'])} - ${_text(item['specialization'], fallback: 'Service')}',
              style: const TextStyle(color: _muted),
            ),
            if (actionable) ...[
              const SizedBox(height: 12),
              AdminResponsiveActions(
                children: [
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: adminDanger,
                      side: const BorderSide(color: adminDanger),
                    ),
                    onPressed: () => _setPayoutStatus(item, 'reject'),
                    child: const AdminLocalizedText('Reject'),
                  ),
                  FilledButton(
                    onPressed: () => _setPayoutStatus(item, 'pay'),
                    child: const AdminLocalizedText('Transfer'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _transactionCard(Map<String, dynamic> item) {
    return _whitePanel(
      child: ListTile(
        leading: const Icon(Icons.receipt_long_rounded, color: _teal),
        title: AdminLocalizedText(
          _text(item['providerName'], fallback: 'Provider'),
          textAlign: TextAlign.right,
          style: const TextStyle(fontWeight: FontWeight.w900),
        ),
        subtitle: AdminLocalizedText(
          'Patient: ${_text(item['patientName'], fallback: '-')}',
          textAlign: TextAlign.right,
        ),
        trailing: AdminLocalizedText(
          _money(item['totalAmount']),
          style: const TextStyle(fontWeight: FontWeight.w900, color: _ink),
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _walletCard(Map<String, dynamic> item) {
    return _whitePanel(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            AdminLocalizedText(
              _text(item['providerName'], fallback: 'Provider'),
              style: const TextStyle(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                _moneyColumn('Total', item['totalEarned']),
                _moneyColumn('Pending', item['pendingAmount']),
                _moneyColumn('Paid', item['paidAmount']),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _moneyColumn(String label, dynamic value) {
    return Expanded(
      child: Column(
        children: [
          AdminLocalizedText(
            _money(value),
            style: const TextStyle(fontWeight: FontWeight.w900, color: _ink),
          ),
          const SizedBox(height: 4),
          AdminLocalizedText(
            label,
            style: const TextStyle(color: _muted, fontSize: 11),
          ),
        ],
      ),
    );
  }

  // ignore: unused_element
  Widget _serviceBar(Map<String, dynamic> item) {
    final count = _int(item['count']);
    final max = _list(
      _performance['services'],
    ).map((e) => _int(e['count'])).fold<int>(1, (a, b) => b > a ? b : a);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Row(
            children: [
              AdminLocalizedText('$count'),
              const Spacer(),
              AdminLocalizedText(
                _text(item['serviceType'], fallback: 'Service'),
              ),
            ],
          ),
          const SizedBox(height: 6),
          LinearProgressIndicator(
            value: (count / max).clamp(0.02, 1.0),
            minHeight: 5,
            color: _teal,
            backgroundColor: const Color(0xFFE4F1F0),
            borderRadius: BorderRadius.circular(99),
          ),
        ],
      ),
    );
  }

  Widget _whitePanel({required Widget child}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _line),
        boxShadow: _shadow,
      ),
      child: child,
    );
  }

  // ignore: unused_element
  Widget _filterRow({
    required String value,
    required Map<String, String> options,
    required ValueChanged<String> onChanged,
  }) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      reverse: true,
      child: Row(
        children: options.entries.map((entry) {
          final selected = value == entry.key;
          return Padding(
            padding: const EdgeInsetsDirectional.only(start: 8),
            child: SizedBox(
              width: 96,
              child: ChoiceChip(
                selected: selected,
                label: Center(child: AdminLocalizedText(entry.value)),
                selectedColor: _teal,
                backgroundColor: _surface,
                labelStyle: TextStyle(
                  color: selected ? _onPrimary : _ink,
                  fontWeight: FontWeight.w700,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(24),
                  side: const BorderSide(color: _line),
                ),
                showCheckmark: false,
                onSelected: (_) => onChanged(entry.key),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _bottomNav() {
    final items = const [
      (Icons.dashboard_outlined, Icons.dashboard_rounded, 'Home', 0),
      (
        Icons.person_add_alt_outlined,
        Icons.person_add_alt_rounded,
        'Requests',
        1,
      ),
      (Icons.groups_outlined, Icons.groups_rounded, 'Providers', 2),
      (Icons.people_outline_rounded, Icons.people_alt_rounded, 'Users', 3),
      (
        Icons.account_balance_wallet_outlined,
        Icons.account_balance_wallet_rounded,
        'Finance',
        5,
      ),
    ];
    final compact = MediaQuery.sizeOf(context).width < 360;
    final navHeight = compact ? 66.0 : 72.0;
    final selectedPosition = items.indexWhere((item) => item.$4 == _tabIndex);
    return SafeArea(
      top: false,
      child: SizedBox(
        width: double.infinity,
        child: Container(
          height: navHeight,
          margin: EdgeInsets.fromLTRB(
            compact ? 8 : 16,
            4,
            compact ? 8 : 16,
            12,
          ),
          decoration: BoxDecoration(
            color: _palette.navBackground,
            borderRadius: BorderRadius.circular(34),
            boxShadow: [
              BoxShadow(
                color: _palette.cardShadowColor(0.12),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final itemWidth = constraints.maxWidth / items.length;
              final visualPosition =
                  context.adminTextDirection == TextDirection.rtl
                  ? items.length - 1 - selectedPosition
                  : selectedPosition;
              final pillWidth = itemWidth * .70;
              final pillHeight = compact ? 36.0 : 40.0;
              return Stack(
                alignment: Alignment.center,
                children: [
                  if (selectedPosition >= 0)
                    AnimatedPositioned(
                      duration: const Duration(milliseconds: 260),
                      curve: Curves.easeOutCubic,
                      left:
                          visualPosition * itemWidth +
                          (itemWidth - pillWidth) / 2,
                      top: (navHeight - pillHeight) / 2,
                      width: pillWidth,
                      height: pillHeight,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: adminTeal.withValues(
                            alpha: _palette.isDark ? .16 : .09,
                          ),
                          borderRadius: BorderRadius.circular(22),
                        ),
                      ),
                    ),
                  Row(
                    children: [
                      for (final item in items)
                        Expanded(
                          child: _adminNavItem(
                            icon: item.$1,
                            activeIcon: item.$2,
                            label: item.$3,
                            selected: _tabIndex == item.$4,
                            onTap: () {
                              if (_tabIndex == item.$4) return;
                              setState(() => _tabIndex = item.$4);
                            },
                          ),
                        ),
                    ],
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _adminNavItem({
    required IconData icon,
    required IconData activeIcon,
    required String label,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final color = selected
        ? adminTeal
        : _palette.isDark
        ? _palette.navUnselected
        : const Color(0xFF718096);
    return Semantics(
      selected: selected,
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(24),
          splashColor: _teal.withValues(alpha: 0.10),
          highlightColor: _teal.withValues(alpha: 0.05),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 240),
            curve: Curves.easeOutCubic,
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 3),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  selected ? activeIcon : icon,
                  size: selected ? 23 : 21,
                  color: color,
                ),
                const SizedBox(height: 2),
                AdminLocalizedText(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: color,
                    fontSize: selected ? 11.5 : 10.5,
                    fontWeight: selected ? FontWeight.w900 : FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ignore: unused_element
  Widget _sectionHeader(String title, String action, VoidCallback onTap) {
    return Row(
      children: [
        TextButton.icon(
          onPressed: onTap,
          icon: const Icon(Icons.chevron_left_rounded, size: 18),
          label: AdminLocalizedText(action),
          style: TextButton.styleFrom(foregroundColor: _darkTeal),
        ),
        const Spacer(),
        AdminLocalizedText(
          title,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
        ),
      ],
    );
  }

  // ignore: unused_element
  Widget _sectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: AdminLocalizedText(
        title,
        textAlign: TextAlign.right,
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
      ),
    );
  }

  Widget _avatar(String text, Color color) {
    return CircleAvatar(
      radius: 24,
      backgroundColor: color,
      child: AdminLocalizedText(
        text,
        style: TextStyle(color: _onPrimary, fontWeight: FontWeight.w900),
      ),
    );
  }

  Widget _pill(String text, Color bg, Color fg) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: AdminLocalizedText(
        text,
        style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w900),
      ),
    );
  }

  Widget _smallMeta(IconData icon, String text) {
    return Flexible(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: _palette.inkMuted, size: 14),
          const SizedBox(width: 3),
          Flexible(
            child: AdminLocalizedText(
              text,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: _muted, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stars(int stars, {double size = 18}) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(
        5,
        (i) => Icon(
          i < stars ? Icons.star_rounded : Icons.star_border_rounded,
          color: const Color(0xFFF1A72E),
          size: size,
        ),
      ),
    );
  }

  Widget _empty(String message) => _whitePanel(
    child: AdminEmptyState(message: message, icon: Icons.inbox_outlined),
  );

  Widget _emptyInline(String message) {
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Row(
        children: [
          Icon(Icons.inbox_rounded, color: _palette.inkMuted),
          const SizedBox(width: 8),
          Expanded(
            child: AdminLocalizedText(message, textAlign: TextAlign.right),
          ),
        ],
      ),
    );
  }

  Future<void> _showProviderDetails(Map<String, dynamic> provider) async {
    final role = _text(provider['role']);
    await showDialog<void>(
      context: context,
      builder: (context) => Directionality(
        textDirection: context.adminTextDirection,
        child: AlertDialog(
          title: AdminLocalizedText(_text(provider['fullName'])),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _detailLine('Role', _roleLabel(role)),
                _detailLine(
                  'Specialization',
                  _text(provider['specialization']),
                ),
                _detailLine(
                  'Experience',
                  '${_int(provider['experienceYears'] ?? provider['years_experience'])} years',
                ),
                _detailLine(
                  'Service Area',
                  _text(provider['serviceAreas'], fallback: 'Not set'),
                ),
                _detailLine(
                  'Rating',
                  _num(provider['overallRating']).toStringAsFixed(1),
                ),
                _detailLine(
                  'Status',
                  _statusLabel(
                    _text(provider['approvalStatus'], fallback: 'pending'),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const AdminLocalizedText('Close'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _detailLine(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: [
          Expanded(
            child: AdminLocalizedText(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(color: _ink, fontWeight: FontWeight.w800),
            ),
          ),
          const SizedBox(width: 12),
          AdminLocalizedText(
            label,
            style: const TextStyle(
              color: _muted,
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showProviderReview(Map<String, dynamic> provider) async {
    final providerId = _text(provider['userId']);
    try {
      final response = await http.get(
        _uri('/admin/providers/$providerId/certifications'),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      final certs = _list(jsonDecode(response.body));
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => Directionality(
          textDirection: context.adminTextDirection,
          child: Dialog(
            insetPadding: const EdgeInsets.symmetric(
              horizontal: 16,
              vertical: 18,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(22),
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 430),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        IconButton(
                          tooltip: context.adminTr('Back'),
                          onPressed: () => Navigator.pop(context),
                          icon: Icon(context.adminBackIcon, color: _teal),
                        ),
                        const Expanded(
                          child: AdminLocalizedText(
                            'Certification Verification',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              color: _ink,
                              fontSize: 15,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: context.adminTr('Language'),
                          onPressed: () {},
                          icon: const Icon(
                            Icons.language_rounded,
                            color: _teal,
                            size: 20,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        _providerPhoto(provider),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              AdminLocalizedText(
                                _text(provider['fullName']),
                                style: const TextStyle(
                                  color: _ink,
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                              const SizedBox(height: 3),
                              AdminLocalizedText(
                                _roleLabel(_text(provider['role'])),
                                style: const TextStyle(
                                  color: Color(0xFF6D7F83),
                                  fontSize: 11.5,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 3),
                              AdminLocalizedText(
                                'Applied on ${_shortDate(provider['createdAt'])}',
                                style: const TextStyle(
                                  color: Color(0xFF9AA8AB),
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        ),
                        _providerStatusPill(
                          _text(
                            provider['approvalStatus'],
                            fallback: 'pending',
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),
                    const AdminLocalizedText(
                      'Uploaded Documents',
                      style: TextStyle(
                        color: _ink,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 10),
                    if (certs.isEmpty)
                      _emptyInline('No documents were uploaded')
                    else
                      Flexible(
                        child: ListView(
                          shrinkWrap: true,
                          children: certs
                              .map((cert) => _providerDocumentTile(cert))
                              .toList(),
                        ),
                      ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: const Color(0xFFE04F5F),
                              side: const BorderSide(color: Color(0xFFFFCBD2)),
                              minimumSize: const Size.fromHeight(46),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            onPressed: () async {
                              await _setApproval(provider, 'rejected');
                              if (context.mounted) Navigator.pop(context);
                            },
                            child: const AdminLocalizedText(
                              'Reject',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: FilledButton(
                            style: FilledButton.styleFrom(
                              backgroundColor: _teal,
                              foregroundColor: _onPrimary,
                              minimumSize: const Size.fromHeight(46),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(8),
                              ),
                            ),
                            onPressed: () async {
                              await _approveReviewedProvider(provider, certs);
                              if (context.mounted) Navigator.pop(context);
                            },
                            child: const AdminLocalizedText(
                              'Approve',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    } catch (e) {
      _toast(e.toString());
    }
  }

  Widget _providerDocumentTile(Map<String, dynamic> cert) {
    final certId = _text(cert['certId'], fallback: '');
    final rawFileUrl = _text(cert['fileUrl'], fallback: '');
    final viewUrl = rawFileUrl.trim().startsWith('data:') && certId.isNotEmpty
        ? _absoluteUploadUrl(
            '/admin/certifications/${Uri.encodeComponent(certId)}/file',
          )
        : _absoluteUploadUrl(rawFileUrl);
    final fileName = _text(
      cert['originalName'],
      fallback: _text(cert['name'], fallback: 'Attached file'),
    );

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _palette.stroke),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.insert_drive_file_outlined,
            color: Color(0xFF7B8D91),
            size: 21,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AdminLocalizedText(
                  _text(cert['name'], fallback: 'Document'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _ink,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 3),
                AdminLocalizedText(
                  fileName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF7B8D91),
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: viewUrl.isEmpty ? null : () => _openUrl(viewUrl),
            style: TextButton.styleFrom(
              foregroundColor: _teal,
              textStyle: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w900,
              ),
            ),
            child: AdminLocalizedText('View'),
          ),
          IconButton(
            tooltip: context.adminTr('Download'),
            onPressed: viewUrl.isEmpty ? null : () => _openUrl(viewUrl),
            icon: Icon(Icons.file_download_outlined, color: _teal, size: 18),
          ),
        ],
      ),
    );
  }

  Future<void> _showCertifications(Map<String, dynamic> provider) async {
    final providerId = _text(provider['userId']);
    try {
      final response = await http.get(
        _uri('/admin/providers/$providerId/certifications'),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      final certs = _list(jsonDecode(response.body));
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => Directionality(
          textDirection: context.adminTextDirection,
          child: AlertDialog(
            title: AdminLocalizedText(
              '${_text(provider['fullName'])} Certificates',
            ),
            content: SizedBox(
              width: 520,
              child: certs.isEmpty
                  ? AdminLocalizedText(
                      'No certificates were uploaded for this account.',
                    )
                  : ListView(
                      shrinkWrap: true,
                      children: certs.map((cert) {
                        final verified = cert['isVerified'] == true;
                        final certId = _text(cert['certId']);
                        final rawFileUrl = _text(cert['fileUrl']);
                        final fileUrl = _absoluteUploadUrl(rawFileUrl);
                        final viewUrl =
                            rawFileUrl.trim().startsWith('data:') &&
                                certId.isNotEmpty
                            ? _absoluteUploadUrl(
                                '/admin/certifications/${Uri.encodeComponent(certId)}/file',
                              )
                            : fileUrl;
                        return ListTile(
                          leading: Icon(
                            verified
                                ? Icons.verified_rounded
                                : Icons.pending_rounded,
                            color: verified ? _teal : Colors.orange,
                          ),
                          title: AdminLocalizedText(_text(cert['name'])),
                          subtitle: AdminLocalizedText(
                            fileUrl.isEmpty
                                ? (verified
                                      ? 'Verified'
                                      : 'Pending verification')
                                : '${verified ? 'Verified' : 'Pending verification'} - ${_text(cert['originalName'], fallback: 'Attached file')}',
                          ),
                          trailing: Wrap(
                            spacing: 6,
                            children: [
                              if (fileUrl.isNotEmpty)
                                OutlinedButton(
                                  onPressed: () => _openUrl(viewUrl),
                                  child: AdminLocalizedText('View file'),
                                ),
                              if (!verified)
                                FilledButton(
                                  style: FilledButton.styleFrom(
                                    backgroundColor: _teal,
                                  ),
                                  onPressed: () async {
                                    await _verifyCertification(
                                      _text(cert['certId']),
                                    );
                                    if (context.mounted) {
                                      Navigator.pop(context);
                                    }
                                  },
                                  child: AdminLocalizedText('Verify'),
                                ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: AdminLocalizedText('Close'),
              ),
            ],
          ),
        ),
      );
    } catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _verifyCertification(String certId) async {
    await _verifyCertificationRequest(certId);
    _toast('Certificate verified');
    await _load();
  }

  Future<void> _verifyCertificationRequest(String certId) async {
    final response = await http.put(
      _uri('/admin/certifications/$certId/verify'),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception(_message(response));
    }
  }

  Future<void> _approveReviewedProvider(
    Map<String, dynamic> provider,
    List<dynamic> certs,
  ) async {
    try {
      for (final cert in certs) {
        if (cert is! Map<String, dynamic>) continue;
        final certId = _text(cert['certId']);
        final alreadyVerified = cert['isVerified'] == true;
        final isDocumentRow = certId.startsWith('document:');
        if (certId.isNotEmpty && !alreadyVerified && !isDocumentRow) {
          await _verifyCertificationRequest(certId);
        }
      }
      await _setApproval(provider, 'approved');
    } catch (e) {
      _toast(e.toString());
    }
  }

  String _absoluteUploadUrl(String url) {
    final trimmed = url.trim();
    if (trimmed.isEmpty) return '';
    if (trimmed.startsWith('data:')) return trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return '${ApiService.baseUrl}${trimmed.startsWith('/') ? '' : '/'}$trimmed';
  }

  Future<void> _openUrl(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) {
      _toast('Could not open the file');
      return;
    }
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      _toast('Could not open the file');
    }
  }

  Future<void> _setApproval(
    Map<String, dynamic> provider,
    String status,
  ) async {
    try {
      final response = await http.put(
        _uri('/admin/providers/${provider['userId']}/approval'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'status': status}),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      _toast(status == 'approved' ? 'Account approved' : 'Account rejected');
      await _load();
    } catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _setUserActive(Map<String, dynamic> user, bool active) async {
    try {
      final response = await http.put(
        _uri('/admin/users/${user['userId']}/status'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'isActive': active}),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      _toast(active ? 'User activated' : 'User disabled');
      await _load();
    } catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _setPayoutStatus(
    Map<String, dynamic> payout,
    String action,
  ) async {
    try {
      final apiAction = action == 'pay' ? 'approve' : action;
      final response = await http.put(
        _uri('/admin/finance/payouts/${payout['payoutId']}/$apiAction'),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      _toast(
        apiAction == 'reject'
            ? 'Payout request rejected'
            : 'Payout transferred',
      );
      await _load();
    } catch (e) {
      _toast(e.toString());
    }
  }

  Future<void> _showPayoutApproval(Map<String, dynamic> payout) async {
    await showDialog<void>(
      context: context,
      builder: (context) => Directionality(
        textDirection: context.adminTextDirection,
        child: Dialog(
          insetPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(22),
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: 430),
            child: Padding(
              padding: EdgeInsets.fromLTRB(18, 16, 18, 18),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      IconButton(
                        tooltip: context.adminTr('Back'),
                        onPressed: () => Navigator.pop(context),
                        icon: Icon(context.adminBackIcon, color: _teal),
                      ),
                      Expanded(
                        child: AdminLocalizedText(
                          'Payout Approval',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: _ink,
                            fontSize: 16,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ),
                      SizedBox(width: 48),
                    ],
                  ),
                  SizedBox(height: 12),
                  Row(
                    children: [
                      AdminAvatar(
                        data: payout,
                        name: _text(
                          payout['providerName'],
                          fallback: 'Provider',
                        ),
                        size: 50,
                        icon: Icons.medical_services_rounded,
                      ),
                      SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            AdminLocalizedText(
                              _text(
                                payout['providerName'],
                                fallback: 'Provider',
                              ),
                              style: TextStyle(
                                color: _ink,
                                fontSize: 14,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            AdminLocalizedText(
                              _text(payout['providerRole'], fallback: 'Nurse'),
                              style: TextStyle(
                                color: Color(0xFF718388),
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            AdminLocalizedText(
                              'Request ID: ${_text(payout['payoutId'])}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: Color(0xFF9AA8AB),
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                      _financeSmallStatus('Pending'),
                    ],
                  ),
                  SizedBox(height: 18),
                  _payoutSummaryBox(payout),
                  SizedBox(height: 14),
                  _payoutBreakdownBox(payout),
                  SizedBox(height: 18),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: _teal,
                            foregroundColor: _onPrimary,
                            minimumSize: Size.fromHeight(46),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                          onPressed: () async {
                            Navigator.pop(context);
                            await _setPayoutStatus(payout, 'pay');
                            if (mounted) _showPaymentSuccess(payout);
                          },
                          child: AdminLocalizedText(
                            'Approve & Pay',
                            style: TextStyle(fontWeight: FontWeight.w900),
                          ),
                        ),
                      ),
                      SizedBox(width: 14),
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Color(0xFFE04F5F),
                            side: BorderSide(color: Color(0xFFFFCBD2)),
                            minimumSize: Size.fromHeight(46),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                          onPressed: () async {
                            Navigator.pop(context);
                            await _setPayoutStatus(payout, 'reject');
                          },
                          child: AdminLocalizedText(
                            'Reject',
                            style: TextStyle(fontWeight: FontWeight.w900),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  // Canonical pricing: providerAmount = provider rate, adminAmount = the
  // commission the patient paid on top of it, patientPaid = sum of both.
  double _payoutProviderAmount(Map<String, dynamic> payout) =>
      _num(payout['providerAmount']) > 0
          ? _num(payout['providerAmount'])
          : _num(payout['amount']);

  double _payoutAdminAmount(Map<String, dynamic> payout) =>
      _num(payout['adminAmount']);

  double _payoutPatientPaid(Map<String, dynamic> payout) =>
      _num(payout['patientPaid']) > 0
          ? _num(payout['patientPaid'])
          : _payoutProviderAmount(payout) + _payoutAdminAmount(payout);

  Widget _payoutSummaryBox(Map<String, dynamic> payout) {
    final sessions = _int(payout['sessionsCovered']) > 0
        ? _int(payout['sessionsCovered'])
        : _int(payout['completedSessions']);
    final providerAmount = _payoutProviderAmount(payout);
    final rate = _num(payout['providerRate']) > 0
        ? _num(payout['providerRate'])
        : (sessions > 0 ? providerAmount / sessions : providerAmount);
    return Container(
      padding: EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _palette.surfaceSoft,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _palette.stroke),
      ),
      child: Column(
        children: [
          _receiptLine('Total Sessions', '$sessions'),
          _receiptLine('Total Points', '$sessions'),
          _receiptLine('Rate per Point', _money(rate)),
          _receiptLine(
            'Patient Paid',
            _money(_payoutPatientPaid(payout)),
            strong: true,
          ),
        ],
      ),
    );
  }

  Widget _payoutBreakdownBox(Map<String, dynamic> payout) {
    final role =
        (payout['providerRole'] ?? '').toString().trim().toLowerCase();
    final providerLabel = role == 'doctor' ? 'Doctor Amount' : 'Nurse Amount';
    return Container(
      padding: EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _palette.stroke),
      ),
      child: Column(
        children: [
          _receiptLine(
            providerLabel,
            _money(_payoutProviderAmount(payout)),
            green: true,
          ),
          _receiptLine('Platform Fee (Admin)', _money(_payoutAdminAmount(payout))),
        ],
      ),
    );
  }

  Future<void> _showPaymentSuccess(Map<String, dynamic> payout) async {
    await showDialog<void>(
      context: context,
      builder: (context) => Directionality(
        textDirection: context.adminTextDirection,
        child: AlertDialog(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(22),
          ),
          title: AdminLocalizedText(
            'Payment Receipt',
            textAlign: TextAlign.center,
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircleAvatar(
                radius: 34,
                backgroundColor: Color(0xFFE5F8EF),
                child: Icon(
                  Icons.check_rounded,
                  color: Color(0xFF1E9D69),
                  size: 38,
                ),
              ),
              SizedBox(height: 14),
              AdminLocalizedText(
                'Payment Successful!',
                style: TextStyle(
                  color: Color(0xFF1E9D69),
                  fontSize: 16,
                  fontWeight: FontWeight.w900,
                ),
              ),
              SizedBox(height: 8),
              AdminLocalizedText(
                'The payment has been sent to ${_text(payout['providerName'], fallback: 'Provider')}',
                textAlign: TextAlign.center,
                style: TextStyle(color: _muted, fontSize: 12),
              ),
              SizedBox(height: 16),
              _receiptLine(
                'Amount Paid',
                _money(payout['amount']),
                strong: true,
              ),
              _receiptLine(
                'Paid On',
                '${_shortDate(DateTime.now())} - ${_shortTime(DateTime.now())}',
              ),
              _receiptLine('Transaction ID', _text(payout['payoutId'])),
              _receiptLine('Payment Method', 'Platform Wallet'),
              _receiptLine('Status', 'Completed', green: true),
            ],
          ),
          actions: [
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: _teal),
              onPressed: () => Navigator.pop(context),
              child: AdminLocalizedText('Download Receipt (PDF)'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showPaymentReceipt(Map<String, dynamic> item) async {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
        title: AdminLocalizedText(
          'Payment Receipt',
          textAlign: TextAlign.center,
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _receiptLine('Provider', _text(item['providerName'])),
            _receiptLine('Patient', _text(item['patientName'])),
            _receiptLine(
              'Amount Paid',
              _money(item['totalAmount']),
              strong: true,
            ),
            _receiptLine('Paid On', _shortDate(item['createdAt'])),
            _receiptLine('Transaction ID', _text(item['paymentId'])),
            _receiptLine('Status', _text(item['escrowStatus']), green: true),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: AdminLocalizedText('Close'),
          ),
        ],
      ),
    );
  }

  Widget _receiptLine(
    String label,
    String value, {
    bool strong = false,
    bool green = false,
  }) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          AdminLocalizedText(
            label,
            style: TextStyle(
              color: Color(0xFF718388),
              fontSize: 11,
              fontWeight: FontWeight.w800,
            ),
          ),
          Spacer(),
          Flexible(
            child: AdminLocalizedText(
              value,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: green ? Color(0xFF1E9D69) : _ink,
                fontSize: strong ? 12.5 : 11.5,
                fontWeight: strong || green ? FontWeight.w900 : FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Map<String, dynamic>? _providerById(String providerId) {
    if (providerId.trim().isEmpty) return null;
    for (final user in _users) {
      if (_text(user['userId'], fallback: '') == providerId) return user;
    }
    return null;
  }

  List<Map<String, dynamic>> _providersForService(String serviceType) {
    final seen = <String>{};
    final providers = <Map<String, dynamic>>[];
    for (final user in _users) {
      final role = _text(user['role']).toLowerCase();
      final userId = _text(user['userId'], fallback: '');
      if (role != serviceType || userId.isEmpty || seen.contains(userId)) {
        continue;
      }
      seen.add(userId);
      providers.add(user);
    }
    return providers;
  }

  String _providerSpecialization(Map<String, dynamic>? provider) {
    return _text(
      provider?['specialization'],
      fallback: 'Select provider first',
    );
  }

  String _pricingSpecializationForSave({
    required String serviceType,
    required String selectedSpecialization,
    required String selectedProviderId,
  }) {
    final provider = _providerById(selectedProviderId);
    final providerSpecialization = _providerSpecialization(provider);
    if (provider != null && providerSpecialization != 'Select provider first') {
      return providerSpecialization;
    }
    if (serviceType == 'nurse') return 'Home Nursing Care';
    return selectedSpecialization.trim().isEmpty
        ? 'General Doctor'
        : selectedSpecialization.trim();
  }

  String _providerExperienceLabel(Map<String, dynamic>? provider) {
    if (provider == null) {
      return 'Experience will be auto-filled after selecting a provider';
    }
    final years = _int(
      provider['experienceYears'] ?? provider['years_experience'],
    );
    final rating = _num(provider['overallRating']);
    final yearText = years == 1 ? '1 year' : '$years years';
    return 'Experience: $yearText • Rating: ${rating.toStringAsFixed(1)}';
  }

  Widget _pricingLabel(String text) {
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: EdgeInsets.only(bottom: 6),
        child: AdminLocalizedText(
          text,
          style: TextStyle(
            color: _ink,
            fontSize: 14,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }

  InputDecoration _pricingInputDecoration({
    required IconData icon,
    String? hintText,
    String? suffixText,
  }) {
    return InputDecoration(
      hintText: hintText,
      suffixText: suffixText,
      prefixIcon: Icon(icon, color: _teal, size: 21),
      filled: true,
      fillColor: _surface,
      contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 15),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: _line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: _line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: _teal, width: 1.4),
      ),
    );
  }

  Future<void> _editPricing([Map<String, dynamic>? item]) async {
    final providerRate = TextEditingController(
      text: item == null ? '' : _num(item['providerRate']).toStringAsFixed(0),
    );
    final savedProviderRate = _num(item?['providerRate']);
    final savedCommission = _num(item?['adminCommission']);
    final commissionPercent = TextEditingController(
      text: item == null || savedProviderRate <= 0
          ? '20'
          : ((savedCommission / savedProviderRate) * 100)
                .clamp(20, double.infinity)
                .toStringAsFixed(0),
    );
    String serviceType = _text(
      item?['providerRole'],
      fallback: 'nurse',
    ).toLowerCase();
    if (serviceType != 'doctor') serviceType = 'nurse';
    String selectedProviderId = item == null
        ? ''
        : _text(item['providerId'], fallback: '');
    String selectedSpecialization = item == null
        ? 'Elderly Care'
        : _text(item['specialization'], fallback: 'Elderly Care');
    const specializations = [
      'Elderly Care',
      'Home Nursing Care',
      'Wound Care',
      'Pediatrics Care',
      'General Doctor',
      'Family Medicine',
      'Cardiology',
    ];
    if (!specializations.contains(selectedSpecialization)) {
      selectedSpecialization = 'Elderly Care';
    }

    final save = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) {
          final providers = _providersForService(serviceType);
          final providerIds = providers
              .map((provider) => _text(provider['userId'], fallback: ''))
              .where((id) => id.isNotEmpty)
              .toSet();
          final validSelectedProviderId =
              providerIds.contains(selectedProviderId)
              ? selectedProviderId
              : null;
          final selectedProvider = validSelectedProviderId == null
              ? null
              : _providerById(validSelectedProviderId);
          if (selectedProvider != null) {
            selectedSpecialization = _providerSpecialization(selectedProvider);
          }
          return Dialog(
            insetPadding: EdgeInsets.symmetric(horizontal: 18, vertical: 20),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 470),
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(18, 18, 18, 20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Center(
                            child: AdminLocalizedText(
                              'Service Pricing & Commission',
                              style: TextStyle(
                                color: _ink,
                                fontSize: 22,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: context.adminTr('Close'),
                          onPressed: () => Navigator.pop(context, false),
                          icon: Icon(
                            Icons.close_rounded,
                            color: _palette.inkMuted,
                          ),
                        ),
                      ],
                    ),
                    SizedBox(height: 6),
                    _pricingLabel('Service type'),
                    DropdownButtonFormField<String>(
                      initialValue: serviceType,
                      decoration: _pricingInputDecoration(
                        icon: Icons.medical_services_outlined,
                      ),
                      items: [
                        DropdownMenuItem(
                          value: 'nurse',
                          child: AdminLocalizedText('Nurse'),
                        ),
                        DropdownMenuItem(
                          value: 'doctor',
                          child: AdminLocalizedText('Doctor'),
                        ),
                      ],
                      onChanged: (value) {
                        if (value == null) return;
                        setDialogState(() {
                          serviceType = value;
                          selectedProviderId = '';
                          selectedSpecialization = value == 'nurse'
                              ? 'Home Nursing Care'
                              : 'General Doctor';
                        });
                      },
                    ),
                    SizedBox(height: 16),
                    _pricingLabel('Provider name'),
                    DropdownButtonFormField<String?>(
                      initialValue: validSelectedProviderId,
                      decoration: _pricingInputDecoration(
                        icon: Icons.person_outline_rounded,
                        hintText: context.adminTr('Select provider'),
                      ),
                      items: [
                        DropdownMenuItem(
                          value: null,
                          child: AdminLocalizedText('Select provider'),
                        ),
                        for (final provider in providers)
                          DropdownMenuItem(
                            value: _text(provider['userId'], fallback: ''),
                            child: AdminLocalizedText(
                              _text(provider['fullName'], fallback: 'Provider'),
                            ),
                          ),
                      ],
                      onChanged: (value) {
                        setDialogState(() {
                          selectedProviderId = value ?? '';
                          final provider = _providerById(selectedProviderId);
                          if (provider != null) {
                            selectedSpecialization = _providerSpecialization(
                              provider,
                            );
                          }
                        });
                      },
                    ),
                    if (serviceType == 'doctor') ...[
                      Center(
                        child: AdminLocalizedText(
                          'Optional for commission-only specialization',
                          style: TextStyle(
                            color: Color(0xFF7A8A99),
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      SizedBox(height: 6),
                      _pricingLabel('Specialization'),
                      if (selectedProvider != null)
                        TextField(
                          readOnly: true,
                          controller: TextEditingController(
                            text: selectedSpecialization,
                          ),
                          decoration: _pricingInputDecoration(
                            icon: Icons.groups_2_outlined,
                          ),
                        )
                      else
                        DropdownButtonFormField<String>(
                          initialValue:
                              specializations.contains(selectedSpecialization)
                              ? selectedSpecialization
                              : specializations.first,
                          decoration: _pricingInputDecoration(
                            icon: Icons.groups_2_outlined,
                          ),
                          items: [
                            for (final specialization in specializations)
                              DropdownMenuItem(
                                value: specialization,
                                child: AdminLocalizedText(specialization),
                              ),
                          ],
                          onChanged: (value) {
                            if (value != null) {
                              setDialogState(
                                () => selectedSpecialization = value,
                              );
                            }
                          },
                        ),
                      SizedBox(height: 6),
                    ],
                    AdminLocalizedText(
                      _providerExperienceLabel(selectedProvider),
                      style: TextStyle(
                        color: Color(0xFF7A8A99),
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    SizedBox(height: 16),
                    _pricingLabel('Provider rate (per hour)'),
                    TextField(
                      controller: providerRate,
                      keyboardType: TextInputType.number,
                      onChanged: (_) => setDialogState(() {}),
                      decoration: _pricingInputDecoration(
                        icon: Icons.attach_money_rounded,
                      ),
                    ),
                    SizedBox(height: 16),
                    Container(
                      width: double.infinity,
                      padding: EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: _palette.surfaceSoft,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: _line),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Material(
                                color: _surface,
                                borderRadius: BorderRadius.circular(14),
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(14),
                                  onTap: () {
                                    final next =
                                        _num(
                                          commissionPercent.text,
                                        ).clamp(20, double.infinity) +
                                        1;
                                    commissionPercent.text = next
                                        .toStringAsFixed(0);
                                    setDialogState(() {});
                                  },
                                  child: Container(
                                    width: 48,
                                    height: 48,
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(14),
                                      border: Border.all(color: _line),
                                    ),
                                    child: Icon(
                                      Icons.add_rounded,
                                      color: _teal,
                                      size: 26,
                                    ),
                                  ),
                                ),
                              ),
                              SizedBox(width: 10),
                              Expanded(
                                child: TextField(
                                  controller: commissionPercent,
                                  keyboardType: TextInputType.number,
                                  onChanged: (_) {
                                    if (_num(commissionPercent.text) < 20 &&
                                        commissionPercent.text.isNotEmpty) {
                                      commissionPercent.text = '20';
                                      commissionPercent.selection =
                                          TextSelection.fromPosition(
                                            TextPosition(offset: 2),
                                          );
                                    }
                                    setDialogState(() {});
                                  },
                                  decoration: _pricingInputDecoration(
                                    icon: Icons.percent_rounded,
                                    hintText: context.adminTr('20'),
                                    suffixText: '%',
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    SizedBox(height: 20),
                    Row(
                      children: [
                        Expanded(
                          child: FilledButton.icon(
                            style: FilledButton.styleFrom(
                              backgroundColor: _teal,
                              foregroundColor: _onPrimary,
                              minimumSize: Size.fromHeight(50),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                            onPressed: () => Navigator.pop(context, true),
                            icon: Icon(Icons.save_rounded, size: 18),
                            label: AdminLocalizedText(
                              'Save',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                          ),
                        ),
                        SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: _teal,
                              side: BorderSide(color: _teal),
                              minimumSize: Size.fromHeight(50),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                            onPressed: () => Navigator.pop(context, false),
                            child: AdminLocalizedText(
                              'Cancel',
                              style: TextStyle(fontWeight: FontWeight.w900),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );

    if (save != true) {
      providerRate.dispose();
      commissionPercent.dispose();
      return;
    }

    try {
      final specializationForSave = _pricingSpecializationForSave(
        serviceType: serviceType,
        selectedSpecialization: selectedSpecialization,
        selectedProviderId: selectedProviderId,
      );
      final response = await http.put(
        _uri('/admin/finance/pricing'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'providerId': selectedProviderId.trim(),
          'specialization': specializationForSave,
          'serviceType': serviceType,
          'providerRate': providerRate.text.trim(),
          'adminCommissionPercent': commissionPercent.text.trim(),
        }),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      _toast('Pricing saved');
      await _load();
    } catch (e) {
      _toast(e.toString());
    } finally {
      providerRate.dispose();
      commissionPercent.dispose();
    }
  }

  Future<void> _editUser(Map<String, dynamic> user) async {
    final name = TextEditingController(text: _text(user['fullName']));
    final phone = TextEditingController(text: _text(user['phone']));
    final specialization = TextEditingController(
      text: _text(user['specialization']),
    );
    final serviceType = TextEditingController(text: _text(user['serviceType']));
    final address = TextEditingController(text: _text(user['addressText']));

    final save = await showDialog<bool>(
      context: context,
      builder: (context) => Directionality(
        textDirection: context.adminTextDirection,
        child: AlertDialog(
          title: AdminLocalizedText('Edit ${_text(user['fullName'])}'),
          content: SizedBox(
            width: 520,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: name,
                  decoration: InputDecoration(
                    labelText: context.adminTr('Full name'),
                  ),
                ),
                TextField(
                  controller: phone,
                  decoration: InputDecoration(
                    labelText: context.adminTr('Phone number'),
                  ),
                ),
                if (_text(user['role']) != 'patient') ...[
                  TextField(
                    controller: specialization,
                    decoration: InputDecoration(
                      labelText: context.adminTr('Specialization'),
                    ),
                  ),
                  TextField(
                    controller: serviceType,
                    decoration: InputDecoration(
                      labelText: context.adminTr('Service type'),
                    ),
                  ),
                ],
                if (_text(user['role']) == 'patient')
                  TextField(
                    controller: address,
                    decoration: InputDecoration(
                      labelText: context.adminTr('Address'),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: AdminLocalizedText('Cancel'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: _teal),
              onPressed: () => Navigator.pop(context, true),
              child: AdminLocalizedText('Save'),
            ),
          ],
        ),
      ),
    );

    if (save != true) return;

    try {
      final response = await http.put(
        _uri('/admin/users/${user['userId']}'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'fullName': name.text,
          'phone': phone.text,
          'specialization': specialization.text,
          'serviceType': serviceType.text,
          'addressText': address.text,
        }),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(_message(response));
      }
      _toast('User details updated');
      await _load();
    } catch (e) {
      _toast(e.toString());
    } finally {
      name.dispose();
      phone.dispose();
      specialization.dispose();
      serviceType.dispose();
      address.dispose();
    }
  }

  List<Map<String, dynamic>> _statsRows(
    List<Map<String, dynamic>> rows,
    List<String> dateKeys,
  ) {
    return rows.where((row) {
      for (final key in dateKeys) {
        final date = _parseStatsDate(row[key]);
        if (date != null) return _isInStatisticsRange(date);
      }
      return false;
    }).toList();
  }

  DateTime? _parseStatsDate(dynamic value) {
    final raw = value?.toString().trim() ?? '';
    if (raw.isEmpty) return null;
    return DateTime.tryParse(raw.replaceFirst(' ', 'T'));
  }

  bool _isInStatisticsRange(DateTime date) {
    final now = DateTime.now();
    late final DateTime start;
    late final DateTime end;
    switch (_statisticsRange) {
      case 'This Week':
        final today = DateTime(now.year, now.month, now.day);
        start = today.subtract(Duration(days: today.weekday - 1));
        end = start.add(Duration(days: 7));
        break;
      case 'This Year':
        start = DateTime(now.year);
        end = DateTime(now.year + 1);
        break;
      case 'This Month':
      default:
        start = DateTime(now.year, now.month);
        end = now.month == 12
            ? DateTime(now.year + 1)
            : DateTime(now.year, now.month + 1);
        break;
    }
    return !date.isBefore(start) && date.isBefore(end);
  }

  Uri _uri(String path) => Uri.parse('${ApiService.baseUrl}$path');

  String _message(http.Response response) {
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map && decoded['error'] != null) {
        return decoded['error'].toString();
      }
      if (decoded is Map && decoded['message'] != null) {
        return decoded['message'].toString();
      }
    } catch (_) {}
    return response.body.isEmpty ? 'Request failed' : response.body;
  }

  String _n(String key) => '${_int(_metrics[key])}';

  String _decimal(String key) {
    final value = double.tryParse('${_metrics[key] ?? 0}') ?? 0;
    return value.toStringAsFixed(1);
  }

  double _num(dynamic value) {
    if (value is num) return value.toDouble();
    return double.tryParse('$value') ?? 0;
  }

  String _money(dynamic value) {
    final amount = _num(value);
    final text = amount % 1 == 0
        ? amount.toStringAsFixed(0)
        : amount.toStringAsFixed(2);
    return '$text ILS';
  }

  String _compactNumber(dynamic value) {
    final number = _num(value);
    if (number >= 1000000) return '${(number / 1000000).toStringAsFixed(1)}M';
    if (number >= 1000) return (number / 1000).toStringAsFixed(3);
    return number.toStringAsFixed(0);
  }

  int _int(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse('$value') ?? 0;
  }

  String _text(dynamic value, {String fallback = '-'}) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  String _shortDate(dynamic value) {
    final raw = value?.toString().trim() ?? '';
    final date = DateTime.tryParse(raw);
    if (date == null) return 'New';
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[date.month - 1]} ${date.day}, ${date.year}';
  }

  String _shortTime(dynamic value) {
    final raw = value?.toString().trim() ?? '';
    final date = DateTime.tryParse(raw);
    if (date == null) return '--:--';
    final hour = date.hour == 0
        ? 12
        : date.hour > 12
        ? date.hour - 12
        : date.hour;
    final minute = date.minute.toString().padLeft(2, '0');
    final suffix = date.hour >= 12 ? 'PM' : 'AM';
    return '$hour:$minute $suffix';
  }

  String _initials(dynamic value) {
    final parts = _text(
      value,
      fallback: '?',
    ).split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.characters.first;
    return '${parts.first.characters.first}${parts.last.characters.first}';
  }

  String _roleLabel(String role) {
    switch (role) {
      case 'doctor':
        return 'Doctor';
      case 'nurse':
        return 'Nurse';
      case 'patient':
        return 'Patient';
      default:
        return role;
    }
  }

  String _statusLabel(String status) {
    switch (status) {
      case 'approved':
        return 'Approved';
      case 'rejected':
        return 'Rejected';
      default:
        return 'Pending';
    }
  }

  String _serviceStatusGroup(String status) {
    final value = status.toLowerCase().trim();
    if (value == 'completed' || value == 'done') return 'completed';
    if (value == 'in_progress' ||
        value == 'accepted' ||
        value == 'confirmed' ||
        value == 'waiting_report') {
      return 'in_progress';
    }
    if (value == 'cancelled' || value == 'canceled' || value == 'rejected') {
      return 'cancelled';
    }
    return 'pending';
  }

  String _serviceStatusLabel(String status) {
    switch (_serviceStatusGroup(status)) {
      case 'completed':
        return 'Completed';
      case 'in_progress':
        return 'In Progress';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Upcoming';
    }
  }

  Color _serviceStatusColor(String group) {
    switch (group) {
      case 'completed':
        return Color(0xFF1E9D69);
      case 'in_progress':
        return Color(0xFFD28A00);
      case 'cancelled':
        return Color(0xFFD83A59);
      default:
        return Color(0xFF0A84D6);
    }
  }

  String _rateStatusLabel(String status) {
    switch (status) {
      case 'accepted':
        return 'Accepted';
      case 'rejected':
        return 'Rejected';
      default:
        return 'Pending approval';
    }
  }

  Color _roleColor(String role) {
    switch (role) {
      case 'doctor':
        return Color(0xFFE35D6A);
      case 'nurse':
        return Color(0xFF0AA0B8);
      case 'patient':
        return Color(0xFF9B6AD6);
      default:
        return _teal;
    }
  }

  Color _statusBg(String status) {
    switch (status) {
      case 'approved':
        return Color(0xFFE3F8EF);
      case 'rejected':
        return Color(0xFFFFE6ED);
      default:
        return Color(0xFFFFF1D8);
    }
  }

  Color _statusFg(String status) {
    switch (status) {
      case 'approved':
        return Color(0xFF1E9D69);
      case 'rejected':
        return Color(0xFFD83A59);
      default:
        return Color(0xFFAC6B00);
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.fixed,
        content: AdminLocalizedText(message.replaceFirst('Exception: ', '')),
      ),
    );
  }
}

List<Map<String, dynamic>> _list(dynamic value) {
  if (value is List) {
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }
  return [];
}

List<BoxShadow> get _shadow => [
  BoxShadow(
    color: const Color(0xFF002B28).withValues(alpha: 0.05),
    blurRadius: 10,
    offset: Offset(0, 5),
  ),
];

List<BoxShadow> get _softDashboardShadow => [
  BoxShadow(
    color: const Color(0xFF002B28).withValues(alpha: 0.04),
    blurRadius: 18,
    offset: Offset(0, 8),
  ),
];

class _StatusSlice {
  _StatusSlice(this.label, this.value, this.color);

  final String label;
  final int value;
  final Color color;
}

class _DonutChartPainter extends CustomPainter {
  _DonutChartPainter(this.slices);

  final List<_StatusSlice> slices;

  @override
  void paint(Canvas canvas, Size size) {
    final total = slices.fold<int>(0, (sum, slice) => sum + slice.value);
    final rect = Offset.zero & size;
    final strokeWidth = size.width * 0.19;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.butt;

    if (total <= 0) {
      paint.color = Color(0xFFE8EEF0);
      canvas.drawArc(
        rect.deflate(strokeWidth / 2),
        -math.pi / 2,
        math.pi * 2,
        false,
        paint,
      );
      return;
    }

    var start = -math.pi / 2;
    for (final slice in slices) {
      if (slice.value <= 0) continue;
      final sweep = (slice.value / total) * math.pi * 2;
      paint.color = slice.color;
      canvas.drawArc(rect.deflate(strokeWidth / 2), start, sweep, false, paint);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DonutChartPainter oldDelegate) =>
      oldDelegate.slices != slices;
}

class _LineChartPainter extends CustomPainter {
  _LineChartPainter(this.values, this.color);

  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final gridPaint = Paint()
      ..color = Color(0xFFEAF0F2)
      ..strokeWidth = 1;
    for (var i = 1; i <= 3; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
    }

    final safeValues = values.isEmpty ? [0.0] : values;
    final maxValue = safeValues.reduce(math.max);
    final minValue = safeValues.reduce(math.min);
    final range = (maxValue - minValue).abs() < 0.01
        ? 1.0
        : maxValue - minValue;
    final stepX = safeValues.length <= 1
        ? size.width
        : size.width / (safeValues.length - 1);

    final path = Path();
    final fillPath = Path();
    for (var i = 0; i < safeValues.length; i++) {
      final x = stepX * i;
      final normalized = (safeValues[i] - minValue) / range;
      final y = size.height - (normalized * (size.height - 22)) - 10;
      if (i == 0) {
        path.moveTo(x, y);
        fillPath.moveTo(x, size.height);
        fillPath.lineTo(x, y);
      } else {
        path.lineTo(x, y);
        fillPath.lineTo(x, y);
      }
    }
    fillPath.lineTo(size.width, size.height);
    fillPath.close();

    final fillPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [color.withValues(alpha: 0.18), color.withValues(alpha: 0.02)],
      ).createShader(Offset.zero & size);
    canvas.drawPath(fillPath, fillPaint);

    final linePaint = Paint()
      ..color = color
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(path, linePaint);

    final dotPaint = Paint()..color = color;
    for (var i = 0; i < safeValues.length; i++) {
      final x = stepX * i;
      final normalized = (safeValues[i] - minValue) / range;
      final y = size.height - (normalized * (size.height - 22)) - 10;
      canvas.drawCircle(Offset(x, y), 4, dotPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _LineChartPainter oldDelegate) =>
      oldDelegate.values != values || oldDelegate.color != color;
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final p = CarelinkPalette.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 84,
              height: 84,
              decoration: BoxDecoration(
                color: Theme.of(
                  context,
                ).colorScheme.error.withValues(alpha: .12),
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.error_outline_rounded,
                size: 44,
                color: Theme.of(context).colorScheme.error,
              ),
            ),
            const SizedBox(height: 20),
            AdminLocalizedText(
              'Something went wrong',
              style: TextStyle(
                color: p.inkDark,
                fontSize: 18,
                fontWeight: FontWeight.w800,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            AdminLocalizedText(
              context.adminError(message),
              style: TextStyle(color: p.inkMuted, height: 1.45),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: const AdminLocalizedText('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
