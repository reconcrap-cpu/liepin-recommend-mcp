export const recommendSelectors = {
  card: '[class*="newResumeItemWrap"]',
  segmentedLabel: ".ant-lpt-segmented-item-label",
  modalRoot: '[class*="resume-detail-modal-wrap"]',
  modalPrintable: '[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content',
  nextButton: ".button-turn-next",
  closeButton: '[class*="resume-detail-modal-wrap"] [class*="closeBtn"]',
  openChatButton: '[class*="resume-detail-modal-wrap"] [class*="xpath-open-im-btn"]'
};

export const chatSelectors = {
  jobFilter: ".im-ui-im-job-filter",
  jobFilterSelector: ".im-ui-im-job-filter .ant-im-select-selector",
  jobSelectionItem: ".im-ui-im-job-filter .ant-im-select-selection-item",
  jobDropdown: ".ant-im-select-dropdown",
  jobOption: ".ant-im-select-dropdown .ant-im-select-item-option",
  unreadCheckbox: ".im-ui-unread-batch-entry label .ant-im-checkbox",
  conversationRow: ".im-ui-contact-list-item.im-ui-contact-item",
  conversationTitleMain: ".im-ui-contact-item-contact .im-ui-contact-title-main",
  conversationTitleSub: ".im-ui-contact-item-contact .im-ui-contact-title-sub",
  resumeActionButton: ".im-ui-action-button.action-item.action-resume",
  genericActionButton: ".im-ui-action-button.action-item",
  specialBrowseButton: "button, a, span, div",
  chatContainer: ".im-ui-chat-container",
  chatContentWrapper: ".im-ui-chat-content-wrapper",
  chatHeader: ".im-ui-pro-chat-header",
  chatHeaderBasicInfo: ".im-ui-pro-chat-header-basic-info-content",
  chatHeaderUserInfo: ".im-ui-pro-chat-header-user-info",
  chatHeaderResumeContent: ".im-ui-pro-chat-header-resume-content",
  chatHeaderExtInfo: ".im-ui-pro-chat-header-ext-info",
  chatHeaderExtContent: ".im-ui-pro-chat-header-ext-content",
  messageList: ".im-ui-message-list-wrapper.im-ui-chat-list, .im-ui-msg-list-content",
  actionBar: ".chatwin-action, .im-ui-chat-input, .actions-left",
  viewResumeButton: ".im-ui-pro-chat-header-basic-info-operate",
  resumeDetailModalRoot: '[class*="resume-detail-modal-wrap"]',
  resumeDetailModalPrintable: '[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content, [class*="resume-detail-modal-wrap"] .printable-content',
  resumeDetailModalCloseButton: '[class*="resume-detail-modal-wrap"] [class*="closeBtn"], [class*="resume-detail-modal-wrap"] [class*="antlpticon-close"]',
  requestResumeConfirmModal: ".ant-im-modal, [role=\"dialog\"]",
  requestResumeSuccessMessage: ".im-ui-message-list-wrapper.im-ui-chat-list .im-ui-message-item-normal-message-wrapper, .im-ui-msg-list-content .im-ui-message-item-normal-message-wrapper",
  toastMessage: ".ant-im-message, .ant-im-notification, .ant-lpt-message, .ant-lpt-notification, [class*=\"toast\"], [class*=\"notification\"]"
};

export const resumeDetailSelectors = {
  printable: ".printable-content",
  pageWrap: '[class*="resume-detail-page-wrap"].printable-content, .resume-detail-page-wrap.printable-content',
  individualInfo: '[class*="individualInfo"]',
  sectionHeader: '[class*="header"]',
  openImButton: '[class*="xpath-open-im-btn"]',
  portfolioWrap: '[class*="xpath-portfolio-wrap"]'
};

export const searchSelectors = {
  listBox: ".xpath-resume-list-box",
  cardWrap: ".xpath-resume-list-box ul > li",
  cardContent: ".xpath-resume-list-box ul > li .xpath-resume-card",
  modalRoot: '[class*="resume-detail-modal-wrap"]',
  modalPrintable: '[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content',
  modalCloseButton: '[class*="resume-detail-modal-wrap"] [class*="closeBtn"] [class*="antlpticon-close"], [class*="resume-detail-modal-wrap"] [class*="closeBtn"]',
  openChatButton: '[class*="resume-detail-modal-wrap"] #res_detail_operation_for_guide [class*="xpath-open-im-btn"], [class*="resume-detail-modal-wrap"] [class*="xpath-open-im-btn"]',
  selectedJobWrap: ".selectJobWrap--Kwt2i, .selectJobWrap--XzJmN, .search-page-select-jobs-wrap",
  selectedJobTrigger: ".selectJobWrap--Kwt2i .ant-lpt-dropdown-trigger, .selectJobWrap--Kwt2i .dropdown-button, .selectJobWrap--XzJmN .ant-lpt-dropdown-trigger, .selectJobWrap--XzJmN .dropdown-button, .search-page-select-jobs-wrap .ant-lpt-dropdown-trigger, .search-page-select-jobs-wrap .dropdown-button",
  selectedJobDropdown: ".search-page-select-jobs-dropdown",
  selectedJobDropdownOpen: ".search-page-select-jobs-dropdown:not(.ant-lpt-dropdown-hidden)",
  searchJobInput: ".searchJobCompanyBox--TnpGe .wrap--IS4Du .job-input, .searchJobCompanyBox--TnpGe .wrap--IS4Du .ant-lpt-select, .searchJobCompanyBox--XzJmN .wrap--XzgzN .job-input, .searchJobCompanyBox--XzJmN .wrap--XzgzN .ant-lpt-select",
  hideReadCheckboxInput: 'input[name="filterRead"].ant-lpt-checkbox-input',
  quickSearchRoot: ".filterContentBox--FSZIQ > div:nth-child(1), .filterContentBox--XzJmN > div:nth-child(1), .saved-condition-container",
  quickProfileTag: ".saved-condition-tag-root",
  quickProfileTitle: 'span[class*="tagTitle--"], [class*="tagTitle--"]',
  serviceJobContainer: '[id^="serviceJobListContainer"]',
  serviceJobRow: '[id^="serviceJobListContainer"] > div > div > div, [id^="serviceJobListContainer"] [class*="jobListWrap"] li',
  pagebar: ".xpath-resume-list-box .resumeListPagebar--OCRUK.hideLast--guqgs > ul",
  nextPageButton: ".xpath-resume-list-box .resumeListPagebar--OCRUK.hideLast--guqgs > ul > li.ant-lpt-pagination-next",
  disabledNextPageButton: ".xpath-resume-list-box .resumeListPagebar--OCRUK.hideLast--guqgs > ul > li.ant-lpt-pagination-next.ant-lpt-pagination-disabled"
};
